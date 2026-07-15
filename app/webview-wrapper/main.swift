// Backfill Web.app — cookbook technique #8: the THINNEST native shell.
// One AppKit window + WKWebView pointing at the Backfill web panel.
// Native cost ~120 lines; all UI stays in index.html. Compare: app/native/
// (full SwiftUI, ~40KB source) vs this (web UI + native window).
import AppKit
import WebKit

let PORT = ProcessInfo.processInfo.environment["BACKFILL_APP_PORT"] ?? "47710"
let BASE = URL(string: "http://localhost:\(PORT)/")!
let REPO = "/opt/Code/github.com/Soul-Brews-Studio/atlas-discord-backfill-oracle"

func probe() -> Bool {
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: BASE.appendingPathComponent("api/stats"))
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        ok = (resp as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 1.5)
    return ok
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKDownloadDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var child: Process?          // bun server we spawned (nil = attached to existing)

    func applicationDidFinishLaunching(_ note: Notification) {
        if !probe() { spawnServer() }
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = NSColor(red: 0x0d/255, green: 0x11/255, blue: 0x17/255, alpha: 1)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Backfill Web"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        waitAndLoad(retries: 40)
    }

    func spawnServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["bun", "\(REPO)/app/server.ts"]
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = "/opt/homebrew/bin:\(home)/.bun/bin:" + (env["PATH"] ?? "")
        env["BACKFILL_SPAWNED_BY_APP"] = "1"     // server self-exits if we crash
        p.environment = env
        try? p.run()
        child = p
    }

    func waitAndLoad(retries: Int) {
        if probe() { webView.load(URLRequest(url: BASE)); return }
        guard retries > 0 else {
            webView.loadHTMLString("<body style='background:#0d1117;color:#e6edf3;font:15px -apple-system'><h3>server ไม่ขึ้นใน 20s — ดู /tmp/backfill-app.log</h3></body>", baseURL: nil)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitAndLoad(retries: retries - 1) }
    }

    // JSON/CSV export buttons navigate to /api/export → route into a real download
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType || response.response.url?.path == "/api/export" {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.begin { r in
            completionHandler(r == .OK ? panel.url : nil)
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        if let c = child, c.isRunning { c.terminate() }   // only the server WE spawned
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
