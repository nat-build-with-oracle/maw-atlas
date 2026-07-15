import SwiftUI

// MARK: - Dashboard: error banner + stat tiles + job log + gaps + channels table

struct DashboardView: View {
    @EnvironmentObject var store: BackfillStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let err = store.errorMessage {
                errorBanner(err)
            }
            StatTilesView(stats: store.stats)
            if let job = store.job, job.title != nil {
                JobLogView(job: job)
            }
            GapsView()
            ChannelsTable()
        }
        .padding(14)
        .background(Theme.bg)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { store.startSweep() } label: {
                    Label("⬇ Sweep ทุก channel", systemImage: "arrow.down.circle")
                }
                .disabled(store.jobRunning)
                .help("POST /api/sweep — incremental cursor sweep ทุก channel")

                Button { store.startGapScan() } label: {
                    Label("🔍 สแกนหา gaps", systemImage: "magnifyingglass.circle")
                }
                .disabled(store.jobRunning)
                .help("POST /api/gaps/scan")

                Button {
                    Task { await store.refreshAll() }
                } label: {
                    Label("↻ รีเฟรช", systemImage: "arrow.clockwise")
                }
                .help("โหลด stats + gaps + job ใหม่")
            }
        }
        .alert("มี job กำลังรันอยู่ รอให้จบก่อนครับ", isPresented: $store.busyAlert) {
            Button("โอเค", role: .cancel) {}
        }
        .sheet(item: $store.messagesSheet) { data in
            MessagesSheet(data: data)
        }
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.bad)
            Text(text)
                .font(.caption.monospaced())
                .foregroundStyle(Theme.bad)
                .lineLimit(2)
                .textSelection(.enabled)
            Spacer()
            Button {
                store.errorMessage = nil
            } label: {
                Image(systemName: "xmark").font(.caption2)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.dim)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bad.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.bad.opacity(0.5)))
    }
}

// MARK: - Stat tiles (LazyVGrid, parity with web tiles)

struct StatTilesView: View {
    let stats: Stats?

    private var guildCount: Int {
        guard let s = stats else { return 0 }
        if !s.guilds.isEmpty { return s.guilds.count }
        return Set(s.channels.compactMap(\.gid)).count   // web fallback
    }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 10) {
            tile(value: stats.map { Fmt.num($0.total) } ?? "…",
                 label: "ข้อความทั้งหมด", color: Theme.accent)
            tile(value: stats.map { Fmt.num($0.channels.count) } ?? "…",
                 label: "channels", color: .white)
            tile(value: stats != nil ? Fmt.num(guildCount) : "…",
                 label: "guilds", color: .white)
            tile(value: stats.map { Fmt.rel($0.lastSweep) } ?? "…",
                 label: "sweep ล่าสุด", color: Theme.good,
                 sub: stats.flatMap { $0.lastSweep }.map { Fmt.thShort($0) })
            tile(value: stats.map { Fmt.num($0.badRows) } ?? "…",
                 label: "rows ค้าง migration (channel ที่ถูกลบ)",
                 color: (stats?.badRows ?? 0) > 0 ? Theme.warn : Theme.dim)
        }
    }

    private func tile(value: String, label: String, color: Color, sub: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(label)
                .font(.caption2.monospaced())
                .foregroundStyle(Theme.dim)
                .lineLimit(2)
            if let sub {
                Text(sub)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.dim.opacity(0.7))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border))
    }
}
