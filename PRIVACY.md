# Privacy Policy — TradePilot（外贸智能助手）

Last updated: 2026-10-23

TradePilot is a browser extension that runs entirely on your device. It has no backend service, no telemetry, and no remote logging.

## 1. What the extension handles

When you start an export on an Alibaba.com seller page, the extension reads the data your own account already sees: inquiry rows, chat messages, customer records, and visitor statistics. That data is used only to build the file you asked for.

## 2. Where data is stored

| Data | Location |
| --- | --- |
| Exported `.xlsx` files | Your local downloads folder |
| Dashboard dataset | IndexedDB inside the extension |
| Settings, API key, pending job state | `chrome.storage.local` / `chrome.storage.session` |
| Login credentials | Never read or stored — requests reuse your existing browser session |

Nothing is uploaded to the author or any third-party analytics service.

## 3. Network requests

The extension sends requests to exactly two kinds of hosts:

1. `*.alibaba.com` — the same page-level endpoints your browser uses when you click around the seller console.
2. The AI endpoint you configure yourself (DeepSeek, DashScope, OpenAI, Zhipu, or a custom URL).

When AI analysis is enabled, the prompt built from your chat data is sent from your browser directly to that endpoint, subject to that provider's own privacy policy. If you never configure a model, no AI request is made.

## 4. Permissions

- `downloads` — save the exported file.
- `scripting` — trigger the download inside the page so the platform's own download path is used.
- `storage` / `unlimitedStorage` — keep settings and the local dashboard dataset.
- Alibaba and AI-provider host permissions — perform the requests described above.

The extension does not request the `cookies` permission and does not inject persistent global hooks.

## 5. Data retention and deletion

- Delete exported files from your downloads folder at any time.
- Remove dashboard data via **Library → Clear all**, or uninstall the extension, which removes its IndexedDB.
- Remove the API key by clearing it in **Settings**, or by uninstalling the extension.

## 6. Children and sensitive data

The extension is intended for business use by Alibaba.com sellers. It is not directed at children and does not intentionally collect sensitive personal data beyond what the seller console already displays to you.

## 7. Changes

Material changes to this policy will be reflected in this file and in the extension version notes.

## 8. Contact

Open an issue in this repository for any privacy question.
