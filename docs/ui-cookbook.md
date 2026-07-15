# Backfill UI Cookbook — 8 หน้ากาก 1 backend

> "เราทำมาทุกแบบทุกเทคนิค เพราะเราเป็นต้นแบบให้คนอื่นได้" — Nat, 2026-07-15

ต้นแบบสำหรับ oracle ทุกตัวใน fleet ที่อยากมี UI: backend เดียว (bun server + sqlite)
ถูกห่อด้วย **ทุกเทคนิค front-end ที่ใช้ได้จริงบน macOS** — สร้าง, verify และรีวิวครบ
ภายในวันเดียว (วันเกิดของ oracle ตัวนี้พอดี) โค้ดทุกชิ้นอยู่ใน repo นี้ ลอกได้เลย

## สถาปัตยกรรมร่วม

```
Discord API ⇄ maw-atlas (429 backoff, cursor sweep) ⇄ messages.sqlite (247k rows)
                                                          │
                              bun app/server.ts :47710 ───┤ JSON API
                                                          │
   ┌──────────┬──────────┬──────────┬─────────┬───────────┼──────────┬─────────┐
   web(dark)  web(linen) SwiftUI    WKWebView  Tauri      tray       bf CLI    bf-tui
```

กติกาที่ทุกหน้ากากทำตาม:
- **Front/back แยกขาด** — UI ไม่แตะ sqlite เขียนเอง ทุก mutation ผ่าน API (ยกเว้น CLI/TUI/tray
  ที่อ่าน sqlite ตรงแบบ readonly ได้ เพราะไม่มี server dependency)
- **Spawn-if-down, kill-only-if-spawned** — native app เปิด server ให้เองถ้ายังไม่รัน
  และปิดเฉพาะตัวที่ตัวเองเปิด (`BACKFILL_SPAWNED_BY_APP=1` + parent-pid watchdog ฝั่ง server
  กัน orphan ตอน Force Quit)
- **หนึ่งเทคนิค หนึ่ง bundle** — ห้ามแย่ง `Backfill.app` กัน (บทเรียนจริง: SwiftUI กับ
  WKWebView เกือบทับกัน)

## ตารางเปรียบเทียบ

| # | เทคนิค | Stack | Source | ขนาด | จุดแข็ง | เลือกเมื่อ |
|---|---|---|---|---|---|---|
| 1 | **Web panel (dark)** | bun + vanilla HTML/JS | `app/index.html` (1 ไฟล์) | 0 (เบราว์เซอร์) | iterate เร็วสุด, แชร์เป็น URL ได้ | เริ่มต้นทุกโปรเจกต์ที่นี่ |
| 2 | **Web สอง skin** | CSS custom properties | `app/bifrost.html` → `/bifrost` | +1 ไฟล์ | design ใหม่โดย logic เดิม 100% | อยากลองภาษา design อื่น |
| 3 | **SwiftUI** | swiftc (ไม่ใช้ Xcode proj) | `app/native/` (8 ไฟล์) | 945K | Table/sort/SavePanel แท้, feel native สุด | แอปหลักที่ใช้ทุกวัน |
| 4 | **WKWebView wrapper** | swiftc 1 ไฟล์ | `app/webview-wrapper/` | 104K | native window ราคา ~120 บรรทัด | อยากได้ window จริงแต่ไม่อยากเขียน UI ใหม่ |
| 5 | **Tauri shell** | Rust + system webview | `app/tauri/` | 7.4MB | pattern เดียวกับ Bifröst, cross-platform | จะ ship ให้คนอื่น/ต่าง OS |
| 6 | **Menu-bar tray** | swiftc 1 ไฟล์ (NSStatusItem) | `app/tray/` | 111K | เห็นตัวเลขตลอดเวลาไม่ต้องเปิดอะไร | metric ที่อยากเหลือบมองทั้งวัน |
| 7 | **CLI (`bf`)** | bun 1 ไฟล์ | `cli/bf.ts` | script | pipe ได้, script ได้, ไม่ง้อ server | automation + คนพิมพ์เร็ว |
| 8 | **TUI (`bf-tui`)** | bun 1 ไฟล์ (ANSI alt-screen) | `cli/bf-tui.ts` | script | จอสดใน terminal, keybindings | นั่งเฝ้า ingest ใน tmux |

## Build commands (ลอกไปใช้)

```bash
# 3. SwiftUI                      # 4. WKWebView          # 5. Tauri
app/native/build.sh               app/webview-wrapper/build.sh
                                                          (cd app/tauri && cargo tauri build)
# 6. Tray                         # 7-8. CLI/TUI
app/tray/build.sh                 ln -s .../cli/bf.ts ~/bin/bf  (ผ่าน shim)
```

## บทเรียนที่จ่ายจริงมาแล้ว

1. **swiftc ตรงๆ ชนะ Xcode project สำหรับ fleet** — build ซ้ำได้บนเครื่อง headless,
   ไฟล์ git-diff ง่าย, ไม่มี pbxproj conflict (precedent: Oracle Display.app 100KB)
2. **SwiftUI @main + swiftc ต้องใส่ `-parse-as-library`** ไม่งั้น "'main' attribute cannot
   be used in a module that contains top-level code"
3. **WKWebView + `http://localhost` ต้องมี `NSAllowsLocalNetworking`** ใน Info.plist
4. **Export/download ใน WKWebView ไม่ทำงานเอง** — ต้อง `decidePolicyFor navigationResponse`
   → `.download` → `WKDownloadDelegate` → `NSSavePanel`
5. **Tauri v2 external URL**: `windows: []` ใน config แล้วสร้างหน้าต่างเองใน `setup` ด้วย
   `WebviewUrl::External` (pattern จาก Bifröst ของ heimdall)
6. **`MAX(message_id)` บน TEXT คือกับดัก** — snowflake ต่างความยาวเทียบ lexicographic ผิด
   → `CAST(... AS INTEGER)` แล้วคืน TEXT (กัน JS precision)
7. **pm2 `cron_restart` env-leak** — env var เปลือยจาก shell ปนเปื้อน override ค่าใน
   ecosystem file เงียบๆ → `env -u cron_restart pm2 start ...`
8. **sqlite หลาย writer ต้อง `busy_timeout` ตั้งแต่วันแรก** — sweep ชน backfill แล้ว
   "database is locked" มาก่อน fix เสมอ
9. **ต้นแบบต้อง verify ของจริงทุกชิ้น** — ทุกเทคนิคในตารางผ่านการรัน/เปิด/กด/quit จริง
   ไม่ใช่แค่ compile ผ่าน

## เครือญาติ

- **ψ Vault Scanner** (`vault-scanner/`, :47711) — sibling app ที่พิสูจน์ว่า pattern นี้
  ลอกได้จริงใน 1 ชั่วโมง: server+FTS5+ledger UI+launcher ครบชุด (38k ไฟล์, 198 vaults)
- **Bifröst** (heimdall) — ต้นทางของ linen ledger design + Tauri pattern
- **maw-fleetpad** (maw-p2p) — ต้นทาง SwiftUI patterns + คำแนะนำ front/back split

---
*atlas-discord-backfill-oracle 🌊📜 — born & shipped 2026-07-15*
