# Analytics fixtures (module F)

**These are fixtures, not live data.** They follow the response shapes documented by the
providers and are used only by unit tests with an injected fake `fetch`. The product never
presents them as real results.

| File | Based on |
|---|---|
| `revenuecat-overview.json` | RevenueCat API v2 `GET /projects/{id}/metrics/overview` documented schema (`object`, `metrics[]{id,name,description,unit,period,value,last_updated_at,last_updated_at_iso8601}`, `currency`); metric ids per RevenueCat's Overview dashboard cards. Values are invented test numbers. |
| `revenuecat-chart-*.json` | RevenueCat API v2 `GET /projects/{id}/charts/{chart_name}`; `values` uses the documented point form `{cohort, measure, value, incomplete}` (cohort = Unix seconds of period start). Values are invented test numbers. |
| `revenuecat-error-403.json` | Documented error body `{type, param, message, retryable, doc_url}`. |
| `app-store-sales-summary.tsv` | App Store Connect Summary Sales Report (tab-separated; Begin/End Date MM/DD/YYYY; Units; Developer Proceeds per unit; Currency of Proceeds; Product Type Identifier; Subscription). Rows are invented test data. |
| `play-installs-country.csv` | Google Play Console installs report columns (Date, Package Name, Country, Daily Device Installs, Daily User Installs, …). Rows are invented test data. |
| `generic-wide.csv`, `generic-long.csv` | Hand-written spreadsheets a founder might export. |

Live responses captured by `pnpm smoke:live analytics` are saved under `fixtures/live/` (redacted).
