# BizApp — Railway Hosting Guide

Invoice | Credit Note | Receipt | Party Ledger | Google Drive Auto-Backup

---

## How Data is Kept Safe on Railway

Your database (`data.db`) is stored on a **persistent volume** attached to your Railway service.
This survives restarts, deploys, and container rebuilds — your data is never lost.

Google Drive nightly backup (11:45 PM IST) acts as a second safety net.

---

## Run Locally (no changes needed)

1. Install Node.js from https://nodejs.org (LTS)
2. Open terminal in this folder
3. `npm install`
4. `npm start`
5. Open http://localhost:3000

---

## Deploy to Railway (step-by-step in main guide)

See the detailed hosting guide provided with this zip file.

