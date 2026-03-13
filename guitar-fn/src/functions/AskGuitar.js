const { app } = require('@azure/functions');
const { AzureOpenAI } = require('openai');

const openai = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_KEY,
    apiVersion: "2024-10-21",
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT
});

const DAB_API_URL = process.env.DAB_API_URL;

/*
 * SYSTEM_PROMPT — instructs GPT-4o to act as a query translator.
 * Its only job is to convert a natural language question into a DAB REST API URL.
 * It must respond with a strict JSON object so the function can parse it reliably.
 *
 * When the question cannot be answered from the DB (e.g. "what pickups does a Les Paul use?"),
 * GPT-4o returns { url: null } — the function then falls back to GENERAL_PROMPT below.
 */
const SYSTEM_PROMPT = `You are a helpful assistant that queries a guitar brand database.
You translate natural language questions into DAB REST API calls.

The database has one entity: GuitarBrand
Fields:
- brand_sk (integer, primary key)
- brand (string) — the brand name
- origin (string) — country of origin, e.g. "U.S.A.", "Japan", "Germany"
- established (integer) — year the company was founded
- mfg_url (string) — manufacturer website URL

DAB REST API rules:
- Base URL: ${DAB_API_URL}/api/GuitarBrand
- Filter syntax: ?$filter=<expression>
- String comparison: field eq 'value'
- Number comparison: field lt 1950, field gt 1900, field eq 1940
- Starts with letter X: brand ge 'X' and brand lt 'Y'  (use next letter of alphabet as upper bound)
- AND: condition1 and condition2
- OR: condition1 or condition2
- IMPORTANT: Do NOT use startswith(), contains(), or any OData functions — they are not supported.
- Order by: ?$orderby=established asc
- Select fields: ?$select=brand,established
- Combine params with &

When the user asks about a substring match (e.g. "brands with 'cruz' in the name", "brands containing 'son'"),
use the special clientFilter response format instead of a DAB filter:
{
  "url": "${DAB_API_URL}/api/GuitarBrand",
  "clientFilter": { "field": "brand", "contains": "<the substring lowercased>" },
  "description": "<one sentence describing what was searched>"
}

For all other questions, respond with ONLY a JSON object in this exact format, nothing else:
{
  "url": "<full DAB API URL with query params>",
  "description": "<one sentence describing what was searched>"
}

If the question cannot be answered from this database (e.g. questions about specific guitar models,
tonewoods, pickups, pricing, or brands not likely in the database), respond with:
{
  "url": null,
  "description": null
}`;

/*
 * GENERAL_PROMPT — used for the fallback call when SYSTEM_PROMPT returns url: null.
 * This turns the same endpoint into a general guitar knowledge assistant.
 * Kept concise (2-4 sentences) so the response fits neatly below the search box.
 */
const GENERAL_PROMPT = `You are a knowledgeable guitar expert with deep knowledge of guitar brands,
their history, notable models, tonewoods, electronics, and the musicians who play them.
Answer the user's question in 2-4 sentences. Be factual, concise, and helpful.
If you are genuinely unsure, say so rather than guessing.`;

app.http('AskGuitar', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log('AskGuitar function called');

        let question;
        try {
            const body = await request.json();
            question = body.question;
        } catch {
            return { status: 400, body: JSON.stringify({ error: 'Request body must be JSON with a "question" field' }) };
        }

        if (!question) {
            return { status: 400, body: JSON.stringify({ error: 'Missing "question" field' }) };
        }

        // ── STEP 1: Ask GPT-4o to translate the question into a DAB API call ──
        let dabUrl, description, clientFilter;
        try {
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: question }
                ],
                max_tokens: 200,
                temperature: 0
            });

            const parsed = JSON.parse(completion.choices[0].message.content);
            dabUrl = parsed.url;
            description = parsed.description;
            clientFilter = parsed.clientFilter;
        } catch (err) {
            context.log('OpenAI error (step 1):', err.message);
            return { status: 500, body: JSON.stringify({ error: 'Failed to interpret question', detail: err.message }) };
        }

        // ── STEP 2: If no DB URL was produced, fall back to general guitar knowledge ──
        // GPT-4o signalled that this question is outside the database schema.
        // Make a second call with the general-knowledge prompt and return the answer
        // as a plain text field rather than a results table.
        if (!dabUrl) {
            context.log('No DAB URL — falling back to general guitar knowledge');
            try {
                const fallback = await openai.chat.completions.create({
                    messages: [
                        { role: 'system', content: GENERAL_PROMPT },
                        { role: 'user', content: question }
                    ],
                    max_tokens: 300,
                    temperature: 0.7   // slight creativity is fine for general knowledge
                });

                const answer = fallback.choices[0].message.content.trim();
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    // answer field signals to the frontend that this is a text response,
                    // not a DB result set — the UI renders it differently (no table)
                    body: JSON.stringify({ answer, results: [] })
                };
            } catch (err) {
                context.log('OpenAI error (step 2 fallback):', err.message);
                return { status: 500, body: JSON.stringify({ error: 'Failed to answer question', detail: err.message }) };
            }
        }

        // ── STEP 3: Call the DAB API with the generated URL ──────────────────
        let results;
        try {
            const dabResponse = await fetch(dabUrl);
            const dabData = await dabResponse.json();
            results = dabData.value || [];
        } catch (err) {
            context.log('DAB API error:', err.message);
            return { status: 500, body: JSON.stringify({ error: 'Failed to query database' }) };
        }

        // Apply client-side filter if requested (for substring/contains queries).
        // DAB's OData engine does not support startswith() or contains(), so GPT-4o
        // returns a clientFilter object and we filter the full result set in Node.js.
        if (clientFilter && clientFilter.contains) {
            const needle = clientFilter.contains.toLowerCase();
            const field = clientFilter.field || 'brand';
            results = results.filter(r => (r[field] || '').toLowerCase().includes(needle));
        }

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, results, dabUrl })
        };
    }
});
