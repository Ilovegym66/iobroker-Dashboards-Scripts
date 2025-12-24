# De’Longhi Dashboard (ioBroker) – Step‑by‑Step Guide

This guide walks you through installing, configuring, and operating the **De’Longhi Dashboard (read‑only)** script for ioBroker.  
It uses the official De’Longhi cloud (Gigya → Ayla) to read device status and statistics and renders a modern HTML dashboard (Default‑1 theme).

> Files you already have:
>
> - `delonghi-dashboard-v2-public.js` – the script (no secrets inside)
> - `README.md` – project overview
>
> This document: **Step‑by‑Step Guide**

---

## 1) Prerequisites

- **ioBroker JavaScript adapter** v9.x or newer
- **Node.js** 16+ on your ioBroker host
- **Axios** available to the JS adapter
  - Usually **already bundled**; if not, add **axios** under *Admin → JavaScript adapter → Settings → Additional NPM modules* and restart the adapter.
- Access to a De’Longhi machine linked to your De’Longhi account (mobile app works).

---

## 2) Install the script

You can either **download** the ready file or copy/paste the contents.

1. Open **ioBroker Admin → Scripts**.
2. Create a **new JavaScript** (type: *Javascript/js*), name it e.g. `Dashboards.DeLonghi-V2`.
3. Paste the contents of `delonghi-dashboard-v2-public.js` into the editor **or** upload the file.
4. **Enable** the script and **save**.

> Download (script):
> - [`delonghi-dashboard-v2-public.js`](sandbox:/mnt/data/delonghi-dashboard-v2-public.js)

---

## 3) Provide credentials (states)

The public script does **not** hardcode credentials. Instead, it reads them from ioBroker states:

```
0_userdata.0.Geraete.Delonghi.Auth.email      (string)
0_userdata.0.Geraete.Delonghi.Auth.password   (string)
0_userdata.0.Geraete.Delonghi.Auth.apiKey     (string, optional)
```

### Option A – via Objects UI
- Go to **Objects**, create the three states under `0_userdata.0.Geraete.Delonghi.Auth.*` (type **string**).
- Fill in your **De’Longhi account e‑mail** and **password**.
- Leave `apiKey` **empty** to use the script’s built‑in default, or paste your app key if you have one.

### Option B – via a one‑time helper snippet
Create a *temporary* script, run once, then disable/delete:
```javascript
const base = '0_userdata.0.Geraete.Delonghi.Auth';
function mk(id,val){ if (existsState(id)) setState(id,val,true); else createState(id,val,true); }
mk(`${base}.email`,    'you@example.com');
mk(`${base}.password`, 'YOUR_PASSWORD');
// Optional: if you have a custom app key, otherwise omit the next line:
mk(`${base}.apiKey`,   '');
```

> **Security note:** These values live in ioBroker states. Restrict Admin access and back up your host securely. The app key is not as sensitive as user credentials, but keep it private anyway.

---

## 4) Optional configuration (states)

The script creates these with sane defaults; you can tweak them anytime:

```
0_userdata.0.Geraete.Delonghi.Config.refresh_on_poll          (boolean, default: true)
0_userdata.0.Geraete.Delonghi.Config.refresh_delay_ms         (number,  default: 2500)
0_userdata.0.Geraete.Delonghi.Config.http_timeout_ms          (number,  default: 20000)
0_userdata.0.Geraete.Delonghi.Config.http_retries             (number,  default: 2)
0_userdata.0.Geraete.Delonghi.Config.http_backoff_ms          (number,  default: 800)
0_userdata.0.Geraete.Delonghi.Config.poll_lock_timeout_ms     (number,  default: 45000)
```

- **refresh_on_poll**: Sends a light *“refresh”* ping before reading properties to coax the cloud to pull fresh stats from the machine (mimics opening “Statistics” in the app).
- **refresh_delay_ms**: Wait time before reading the properties after the refresh ping.
- **http_* and retries**: Stability and performance controls.
- **poll_lock_timeout_ms**: Prevents overlapping polls.

> The poll interval is set inside the script (`intervalMinuten`, default: 1). Adjust as needed.

---

## 5) Theme (Default‑1) and frame

The dashboard tries to read your **Default‑1** theme and frame from these states and falls back to built‑ins:

```
0_userdata.0.vis.Templates.Default1.css
0_userdata.0.vis.Templates.Default1.frameHtml
```

If you already maintain your own Default‑1 assets (recommended), make sure they are present in those states.  
If not, the script injects a solid default CSS + frame automatically.

---

## 6) First run

1. Ensure the credential states from **Step 3** are present.
2. **Enable** the script.
3. Watch the **log**:
   - `✅ Login erfolgreich`
   - `🔍 N Geräte gefunden`
   - Subsequent render messages

The dashboard HTML is written to:
- `0_userdata.0.Geraete.Delonghi.Statushtml`
- `0_userdata.0.vis.Dashboards.DelonghiHTML`  *(for VIS/MinuVis)*

Open your visualization and bind to `0_userdata.0.vis.Dashboards.DelonghiHTML` (HTML widget).

---

## 7) What you will see

Per device card:
- Connection badge (online/offline)
- Status badge (app/machine state)
- **Staleness** badge if data is older than 5 minutes (⏳ “Veraltet”)
- **Summaries** (key d500+ aggregates; e.g., beverage counters, water qty, times)
- **Table** of raw d500+ keys (filtered for noisy service keys)

> Totals like `d701_tot_bev_b` are surfaced automatically once the cloud provides the updated properties.  
> The refresh ping helps to trigger a fresh sync upstream.

---

## 8) Known behavior & tips

- The De’Longhi cloud sometimes serves **stale stats** until the app “nudges” the machine. The script’s **refresh_on_poll** emulates this. If you still see stale data, try increasing `refresh_delay_ms` (e.g., 4000–6000 ms).
- If a device shows **Offline** but you can brew locally, let the machine sit on Wi‑Fi for a bit and trigger a refresh; cloud connectivity can lag.
- Poll overlap protection: if a poll takes too long, the next one is skipped to avoid piling requests.
- Read‑only by design: **no brew/power commands** in this public build.

---

## 9) Troubleshooting

**401 Unauthorized**  
- Wrong credentials: fix `Auth.email` / `Auth.password`.
- Session expired: the script re‑authenticates automatically on 401; check the log for a fresh `✅ Login erfolgreich`.

**Timeouts (EAI_AGAIN / ETIMEDOUT / ECONNRESET)**  
- Unreliable WAN/DNS: the script retries with exponential backoff.
- Increase `http_timeout_ms` (e.g., 30000) or `http_retries` (e.g., 3).

**Stale (“Veraltet”) despite refresh**  
- Increase `refresh_delay_ms` to 4000–6000.
- Ensure the machine is connected (good Wi‑Fi).
- Check that the **mobile app** can show up‑to‑date stats; if the app is stale too, it’s a cloud side delay.

**No theme applied**  
- Populate `0_userdata.0.vis.Templates.Default1.css` and `...frameHtml`, or let the built‑in fallback run.

**No devices discovered**  
- Confirm your account actually has the machine bound in the app.
- The script logs each device (by DSN) found after login.

---

## 10) Updating the script

- Replace the code in your script with the new version and **save**.
- Keep your **Auth** and **Config** states – no need to touch them.

---

## 11) Security notes

- Credentials live in `0_userdata.0.*` states. Limit Admin access, secure backups, and never share screenshots with secrets visible.
- The **app key** (if you provide one) is less sensitive than credentials but treat it as private anyway.

---

## 12) Where the output goes

- Dashboard HTML:  
  `0_userdata.0.Geraete.Delonghi.Statushtml`  
  `0_userdata.0.vis.Dashboards.DelonghiHTML`

- Per‑device raw states:  
  `0_userdata.0.Geraete.Delonghi.<DSN>.Status.*` (d500+ keys only, filtered for service noise)

---

## 13) Uninstall

- Disable and delete the script.
- Optionally delete `0_userdata.0.Geraete.Delonghi.*` and the dashboard state under `0_userdata.0.vis.Dashboards.DelonghiHTML`.

---

## 14) FAQ

**Q: Do I need to set an API key?**  
A: No. The script ships with a working default. If De’Longhi rotates keys, create `...Auth.apiKey` and paste your key to override.

**Q: Can I change the polling interval?**  
A: Yes. Edit `intervalMinuten` at the top of the script and save.

**Q: Can this brew coffee or power on/off?**  
A: This public build is **read‑only** for robustness. Control paths vary per model and are intentionally excluded.

---

### Enjoy your coffee dashboard!
