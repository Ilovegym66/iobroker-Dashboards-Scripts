# DeLonghi Dashboard (ioBroker JavaScript)
Read‑only Dashboard for De’Longhi “Coffee Link” devices via Ayla/Gigya API. Uses Axios with retries, keep‑alive, and an optional pre‑poll refresh to pull up‑to‑date statistics.

> **No commands are sent to the machine** (no brew/power). This script only reads and renders data.

---

## Features
- **Stable login flow**: Gigya → JWT → Ayla (`token_sign_in`)  
- **Axios + Keep‑Alive** for fewer TCP handshakes  
- **Exponential backoff retries** on timeouts/network errors  
- **401 → automatic re‑login** and retry  
- **Optional refresh ping** (`app_data_request`) before each poll to trigger fresh values (like opening “Statistics” in the app)  
- **Overlap protection** via **poll lock**  
- **Default‑1 Theme** (CSS/HTML taken from states or internal fallback)  
- Data filters to hide noisy/service keys (e.g., `d580`, `d581`, `d702`, `d733..d740`)  
- Writes HTML to:
  - `0_userdata.0.Geraete.Delonghi.Statushtml`
  - `0_userdata.0.vis.Dashboards.DelonghiHTML`

---

## Prerequisites
- ioBroker JavaScript engine (v9+ recommended).  
- `axios` available in the JS engine environment.  
- A De’Longhi device connected to the **Ayla** cloud (Coffee Link).

---

## Installation
1. Create a new script in ioBroker (JavaScript adapter) and paste the contents of `delonghi-dashboard.js`.
2. Ensure the following states exist (the script creates empty ones on first run):
   - `0_userdata.0.Secrets.Delonghi.username`
   - `0_userdata.0.Secrets.Delonghi.password`
   - `0_userdata.0.Secrets.Delonghi.gigya_apiKey`
   - `0_userdata.0.Secrets.Delonghi.app_id`
   - `0_userdata.0.Secrets.Delonghi.app_secret`
3. Fill the **Secrets** states with your credentials/app values (or provide via environment variables):
   - `DELONGHI_USER`, `DELONGHI_PASS`, `DELONGHI_GIGYA_APIKEY`, `DELONGHI_APP_ID`, `DELONGHI_APP_SECRET`.
4. Optional: provide **Default‑1** theme states for styling (otherwise a built‑in fallback is used):
   - CSS:   `0_userdata.0.vis.Templates.Default1.css`
   - Frame: `0_userdata.0.vis.Templates.Default1.frameHtml`

> The public *Gigya* `apiKey` identifies the Coffee Link mobile app. The Ayla `app_secret` is formally a client secret — **do not commit it** to public repos.

---

## Configuration
All config values live under `0_userdata.0.Geraete.Delonghi.Config.*` and are created with sensible defaults:

- `interval_min` (default `1`) — Poll interval in minutes.  
- `refresh_on_poll` (default `true`) — Send `app_data_request` before reading values.  
- `refresh_delay_ms` (default `2500`) — Wait between refresh ping and reading the properties.  
- `http_timeout_ms` (default `20000`) — Axios request timeout in ms.  
- `http_retries` (default `2`) — Number of retries on timeouts/network errors.  
- `http_backoff_ms` (default `800`) — Initial backoff; doubles each retry + jitter.  
- `poll_lock_timeout_ms` (default `45000`) — Overlap protection.  
- `stale_threshold_sec` (default `300`) — Show “stale” badge when values are older than 5 minutes.

---

## Output
- Device names are written to `0_userdata.0.Geraete.Delonghi.<DSN>.Name`  
- All d500+ property values (excluding filtered keys) are stored under `0_userdata.0.Geraete.Delonghi.<DSN>.Status.*`  
- Two HTML outputs (for VIS/MinuVis):
  - `0_userdata.0.Geraete.Delonghi.Statushtml`
  - `0_userdata.0.vis.Dashboards.DelonghiHTML`

---

## Notes & Tips
- If your values only update **after** opening “Statistics” in the phone app, keep `refresh_on_poll = true`. This script sends `app_data_request` to prompt the cloud to fetch fresh stats from the device, then waits (`refresh_delay_ms`) before polling.
- Some devices/firmwares may not support `app_data_request`; you will see a warning but polling still works.
- The script intentionally avoids **any** control (no brew/power), to keep traffic simple and read‑only.

---

## Security & Legal
- **Do not publish** your username/password or the **Ayla app_secret**. Use ioBroker states or environment variables.
- Respect the vendor’s terms of service. This code is provided **as‑is** without warranty.
- API structures and client keys may change; use at your own risk.

---

## Changelog
- **v2.0.0-public**
  - Secrets moved to states/ENV; no credentials in code
  - Read‑only polling kept, commands removed
  - Optional `app_data_request` refresh before polls
  - Retries, keep‑alive, poll‑lock, stale badge
  - Default‑1 theme integration with state overrides

---

## License
MIT
