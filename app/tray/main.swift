// Backfill Tray.app — cookbook technique: menu-bar glance (NSStatusItem,
// like Oracle Pulse). No window: row count + sweep age live in the menu bar;
// menu actions cover the common verbs. Reads the archive sqlite DIRECTLY
// (readonly, via /usr/bin/sqlite3) so it works even when no server runs.
import AppKit

let DB = ProcessInfo.processInfo.environment["ATLAS_ROUTE_DB"]
    ?? "/opt/Code/github.com/Soul-Brews-Studio/atlas-oracle/.maw/atlas-route/messages.sqlite"
let SWEEP_LOG = NSHomeDirectory() + "/.pm2/logs/mirror-ingest-sweep-out.log"
let PANEL = "http://localhost:47710/"
let REPO = "/opt/Code/github.com/Soul-Brews-Studio/atlas-discord-backfill-oracle"

func sqlite(_ query: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    p.arguments = ["-readonly", DB, query]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func sweepAge() -> String {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: SWEEP_LOG),
          let m = attrs[.modificationDate] as? Date else { return "?" }
    let s = Int(-m.timeIntervalSinceNow)
    if s < 90 { return "\(s)s" }
    if s < 5400 { return "\(s / 60)m" }
    return "\(s / 3600)h"
}

final class TrayDelegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var timer: Timer?
    let fmt: NumberFormatter = { let f = NumberFormatter(); f.numberStyle = .decimal; return f }()

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        buildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func buildMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "อัพเดตตัวเลข", action: #selector(refreshAction), keyEquivalent: "r").target = self
        menu.addItem(withTitle: "เปิด control panel", action: #selector(openPanel), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "เปิด Backfill.app (SwiftUI)", action: #selector(openApp), keyEquivalent: "b").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Sweep เดี๋ยวนี้", action: #selector(sweepNow), keyEquivalent: "s").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "ออก", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    func refresh() {
        let raw = sqlite("SELECT COUNT(*) FROM discord_messages") ?? "?"
        let n = Int(raw).flatMap { fmt.string(from: NSNumber(value: $0)) } ?? raw
        item.button?.title = "🌊 \(n) · \(sweepAge())"
    }

    @objc func refreshAction() { refresh() }
    @objc func openPanel() { NSWorkspace.shared.open(URL(string: PANEL)!) }
    @objc func openApp() { NSWorkspace.shared.open(URL(fileURLWithPath: "\(REPO)/app/Backfill.app")) }
    @objc func sweepNow() {
        // POST to the panel server if up; otherwise run the sweep script directly
        var req = URLRequest(url: URL(string: PANEL + "api/sweep")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, resp, err in
            if err != nil || (resp as? HTTPURLResponse)?.statusCode ?? 500 >= 500 {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/zsh")
                p.arguments = ["/opt/Code/github.com/nat-build-with-oracle/maw-atlas/scripts/ingest-sweep.sh"]
                try? p.run()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.refresh() }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = TrayDelegate()
app.delegate = delegate
app.run()
