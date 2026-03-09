# Architecture Guide: DAB + Azure Container App + Static Web App

A detailed breakdown of every component in this solution, how they connect, and what you need to replicate it in a new environment.

---

## The Big Picture

```
Browser
  │
  ├── GET index.html ──────────────► Azure Static Web App
  │                                   (serves static files)
  │
  └── fetch() API calls ───────────► Azure Container App (DAB)
                                       │
                                       └── SQL queries ────► Azure SQL Database
```

Three tiers. No custom backend code. The "API" is a generic engine configured by a JSON file.

---

## Component 1: Azure SQL Database

**What it is:** A fully managed relational database (SQL Server engine) in the cloud.

**What it does here:** Stores the `dbo.guitar_brands` table.

| Column | Type | Notes |
|---|---|---|
| `brand_sk` | INT | Primary key — **not** auto-increment, you supply it on insert |
| `brand` | VARCHAR | Brand name |
| `origin` | VARCHAR | Country of origin |
| `mfg_url` | VARCHAR | Manufacturer website |
| `established` | INT | Year founded |

**Key decisions:**
- `brand_sk` is a regular INT, not an identity column. DAB requires the PK to be included in the POST body on create.
- The database lives in its own resource group (`pawlowski_dev`) separate from the app resources (`dab_resource`) — common in organizations where DBAs manage data separately from app teams.

**Connection string format for DAB:**
```
Server=<server>.database.windows.net;Database=<db>;User Id=<user>;Password=<pw>;TrustServerCertificate=True;
```

**To replicate:** Any SQL Server-compatible database works — Azure SQL, on-prem SQL Server, Azure SQL Managed Instance. DAB also supports PostgreSQL, MySQL, and Cosmos DB.

---

## Component 2: Data API Builder (DAB)

**What it is:** An open-source Microsoft engine that reads a JSON config and automatically generates a REST (and optionally GraphQL) API over your database — zero custom code required.

**What it does here:** Translates HTTP requests like `GET /api/GuitarBrand` into SQL queries against `dbo.guitar_brands` and returns JSON.

### The Config File

`swa-db-connections/staticwebapp.database.config.json` is the heart of DAB:

```json
{
  "data-source": {
    "database-type": "mssql",
    "connection-string": "@env('DATABASE_CONNECTION_STRING')"
  },
  "entities": {
    "GuitarBrand": {
      "source": "dbo.guitar_brands",
      "permissions": [
        { "role": "anonymous", "actions": ["create", "read", "update", "delete"] }
      ]
    }
  }
}
```

- `@env('DATABASE_CONNECTION_STRING')` — DAB reads the connection string from an environment variable, never hardcoded.
- The entity name (`GuitarBrand`) becomes the URL path segment: `/api/GuitarBrand`.
- `permissions` controls who can do what. `anonymous` means no auth required. Roles can be locked down to Entra ID groups for production.

### URL Conventions DAB Generates Automatically

| Operation | HTTP Method | URL |
|---|---|---|
| Get all | GET | `/api/GuitarBrand` |
| Get one | GET | `/api/GuitarBrand/brand_sk/5` |
| Create | POST | `/api/GuitarBrand` — PK in body |
| Update | PUT | `/api/GuitarBrand/brand_sk/5` — PK in URL, **not** in body |
| Delete | DELETE | `/api/GuitarBrand/brand_sk/5` |

### OData Query Support — Built-in, No Configuration Needed

| Parameter | Purpose | Example |
|---|---|---|
| `$filter` | Server-side filtering | `?$filter=origin eq 'USA'` |
| `$orderby` | Server-side sorting | `?$orderby=established` |
| `$select` | Column projection | `?$select=brand,origin` |
| `$top` / `$skip` | Pagination | `?$top=10&$skip=20` |

OData filtering happens in SQL — the database does the work, only matching rows are returned over the wire. This is more efficient than fetching everything and filtering in JavaScript.

**Multiple `$filter` conditions** use `or` / `and`:
```
?$filter=origin eq 'USA' or origin eq 'U.S.A.' or origin eq 'U.S.A'
```

### OData vs. JavaScript Filtering

| | OData (`$filter`) | JavaScript (client-side) |
|---|---|---|
| Where filtering happens | SQL Server | Browser |
| Data transferred | Only matching rows | All rows |
| Best for | Known, stable filters | Dynamic, user-driven UI |
| Multiple API calls on one page | Yes — each call can have different filters | N/A |

**To replicate:** DAB is open source at `microsoft/data-api-builder` on GitHub. The Docker image is `mcr.microsoft.com/azure-databases/data-api-builder`. Point it at any supported database, define entities, set permissions — done.

---

## Component 3: Azure Container App

**What it is:** A managed serverless container hosting platform. You provide a Docker image and it runs it — no VM management, no Kubernetes expertise needed.

**What it does here:** Runs the DAB Docker image with your config injected at startup via environment variables.

### The Config Injection Pattern

The Container App uses a **startup command override**:

```bash
printenv DAB_CONFIG > /App/dab-config.json && dotnet /App/Microsoft.DataApiBuilder.dll start
```

At container startup this:
1. Reads the `DAB_CONFIG` environment variable
2. Writes its value as-is to `/App/dab-config.json`
3. Starts DAB pointing at that file

> **Critical:** The secret must contain **raw JSON** — not base64 encoded. `printenv` writes the value directly without any decoding step.

### Container App Secrets

| Secret name | Contains | Mapped to env var |
|---|---|---|
| `dbconn` | SQL connection string | `DATABASE_CONNECTION_STRING` |
| `dabconfig` | Raw JSON of DAB config file | `DAB_CONFIG` |

### Updating the DAB Config After Changes

When you edit `staticwebapp.database.config.json` (e.g., add an entity, change permissions), you must push the new config to the Container App manually:

```bash
# 1. Update the secret with new config content (raw JSON)
az containerapp secret set \
  --name dab-api \
  --resource-group dab_resource \
  --secrets "dabconfig=$(cat swa-db-connections/staticwebapp.database.config.json)"

# 2. Force a new revision so the container restarts and reads the new secret
az containerapp update \
  --name dab-api \
  --resource-group dab_resource \
  --set-env-vars "FORCE_RESTART=$(date +%s)"
```

A new revision is required because Container Apps don't automatically restart when a secret value changes.

### Adding a New Entity

When you add a new entity to the DAB config, the URL pattern is automatic:

```
/api/{EntityName}
```

For example, adding a `GuitarModel` entity pointing at `dbo.guitar_models` would immediately expose `/api/GuitarModel` with full CRUD — after pushing the updated config to the Container App.

### Scale-to-Zero

`minReplicas=0` means the container shuts down when idle. The first request after a period of inactivity takes ~15–30 seconds (cold start). Set `minReplicas=1` to keep it always warm at the cost of continuous billing.

**To replicate:** Any container hosting platform works — Azure Container Apps, Azure App Service (Web App for Containers), AWS ECS, GCP Cloud Run, or a VM with Docker. The config injection pattern via env vars applies everywhere.

---

## Component 4: Azure Static Web App (SWA)

**What it is:** A globally distributed CDN-backed hosting service for static files (HTML, CSS, JS). The Free tier includes custom domains, HTTPS, and GitHub Actions CI/CD.

**What it does here:** Serves `index.html` to browsers. Nothing more — no server-side logic.

### GitHub Actions Workflow

`.github/workflows/azure-static-web-apps-white-ground-00d81a50f.yml` is auto-created by Azure when you connect the SWA to a GitHub repo.

Critical settings for a plain HTML project:

```yaml
app_location: "/"        # where your files are in the repo
output_location: ""      # no build output folder
skip_app_build: true     # tells Oryx NOT to try to build the project
```

Without `skip_app_build: true`, Azure's Oryx build engine detects files in the repo and attempts `npm install` / `npm build`, which fails on a plain HTML project with no `package.json`.

### Deployment Flow

```
git push to main
       │
       ▼
GitHub Actions workflow triggers
       │
       ▼
Azure/static-web-apps-deploy@v1 action uploads files
       │
       ▼
SWA CDN propagates globally
       │
       ▼
Live at https://white-ground-00d81a50f.2.azurestaticapps.net
```

The `.2.` in the URL indicates East US 2 region. This is determined at SWA creation time.

**To replicate:** Any static hosting works — GitHub Pages, Netlify, Cloudflare Pages, Azure Blob Storage with static website hosting, AWS S3 + CloudFront. SWA's advantage is the free built-in GitHub Actions integration and HTTPS.

---

## Component 5: The Frontend (index.html)

A single plain HTML file with vanilla JavaScript — no framework, no build step, no `node_modules`.

### Key Patterns

**Multiple API calls on the same page:**
```javascript
loadAllBrands();   // GET /api/GuitarBrand
loadUSABrands();   // GET /api/GuitarBrand?$filter=origin eq 'USA' or ...
```
Each call is independent. Both fire on page load and populate separate sections.

**OData response shape** — DAB always wraps results:
```json
{ "value": [ { ... }, { ... } ] }
```
Always access `data.value` in JavaScript.

**CRUD payload rules** (DAB-specific — applies to all DAB projects):

```javascript
// POST — include PK if column is not auto-increment
const payload = { brand_sk: 10, brand: "Gibson", origin: "U.S.A.", established: 1902 };
fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) });

// PUT — PK goes in the URL only, never in the body
const payload = { brand: "Gibson", origin: "U.S.A.", established: 1902 }; // no brand_sk
fetch(`${API_URL}/brand_sk/10`, { method: 'PUT', body: JSON.stringify(payload) });

// DELETE — PK in URL, no body
fetch(`${API_URL}/brand_sk/10`, { method: 'DELETE' });
```

**Edit form state management** — the same form is used for both Add and Edit:
- Add mode: ID field visible, submit says "Add Brand"
- Edit mode: ID field hidden (PK stored in `form.dataset.editId`), submit says "Update Brand"
- The spread operator handles the payload difference:
  ```javascript
  const payload = {
      ...(isEdit ? {} : { brand_sk: parseInt(data.brand_sk) }),
      brand: data.brand,
      origin: data.origin,
      mfg_url: data.mfg_url,
      established: parseInt(data.established)
  };
  ```

**Chart.js timeline** — scatter chart with `showLine: true` acts as a horizontal timeline. `chartjs-plugin-datalabels` adds brand name labels rotated above each point.

---

## Full Request Flow

### Page Load

```
1. Browser → GET https://white-ground-00d81a50f.2.azurestaticapps.net
2. SWA CDN → returns index.html
3. Browser executes loadAllBrands() and loadUSABrands() simultaneously
4. Both fetch() → Container App (DAB)
5. DAB → SQL queries → Azure SQL
6. Azure SQL → results → DAB → JSON → Browser
7. JavaScript renders tables and chart
```

### Delete a Record

```
1. User clicks Delete → confirm() dialog
2. fetch(url, { method: 'DELETE' }) → Container App
3. DAB → DELETE FROM dbo.guitar_brands WHERE brand_sk = ?
4. On success → loadAllBrands() and loadUSABrands() re-fetch and re-render
```

---

## Replication Checklist

To build this in a new environment with a different database and subject:

| Step | What to do |
|---|---|
| 1. Database | Create a SQL Server database, create your table(s), note the connection string |
| 2. DAB config | Copy `staticwebapp.database.config.json`, update `entities` for your tables and column names |
| 3. Container App | Create with image `mcr.microsoft.com/azure-databases/data-api-builder:latest`, set the two secrets (`dbconn` → connection string, `dabconfig` → raw config JSON), set the startup command override |
| 4. Frontend | Create `index.html`, set `API_URL` to your Container App's ingress URL, use `fetch()` with OData params as needed |
| 5. Static hosting | Push to GitHub, connect to SWA (or any static host), add `skip_app_build: true` if using SWA |

**The only things that change per project:** the DAB config (which tables/entities to expose and what permissions to set) and the frontend HTML (what to display and how). The infrastructure pattern is identical.

---

## Key Azure Resources in This Project

| Resource | Type | Resource Group | Purpose |
|---|---|---|---|
| `white-ground-00d81a50f` | Static Web App | `dab_resource` | Serves index.html |
| `dab-api` | Container App | `dab_resource` | Runs DAB engine |
| `dab-env` | Container Apps Environment | `dab_resource` | Hosts the Container App |
| `pawlowski-sql-srv` | SQL Server | `pawlowski_dev` | Database server |
| `pawlowski_sql_db` | SQL Database | `pawlowski_dev` | Stores guitar_brands table |

**Live API endpoint:**
```
https://dab-api.thankfulsmoke-edcf3214.eastus2.azurecontainerapps.io/api/GuitarBrand
```

**Live frontend:**
```
https://white-ground-00d81a50f.2.azurestaticapps.net
```
