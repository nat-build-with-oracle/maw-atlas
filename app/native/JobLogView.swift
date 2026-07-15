import SwiftUI

// MARK: - Job panel: title + live log tail, auto-scrolled to bottom

struct JobLogView: View {
    let job: JobState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(job.done ? "✓" : "⏳")
                    .font(.caption.monospaced().weight(.heavy))
                    .foregroundStyle(job.done ? Theme.good : Theme.warn)
                Text(job.title ?? "")
                    .font(.caption.monospaced().weight(.heavy))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                if !job.done {
                    ProgressView().controlSize(.small).tint(Theme.accent)
                }
                Spacer()
                if let started = job.startedAt {
                    Text("เริ่ม \(Fmt.thShort(started))")
                        .font(.caption2.monospaced())
                        .foregroundStyle(Theme.dim)
                }
                if job.done, let code = job.code {
                    Text("exit \(code)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(code == 0 ? Theme.good : Theme.bad)
                }
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(job.lines.enumerated()), id: \.offset) { _, line in
                            Text(line.isEmpty ? " " : line)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(lineColor(line))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .textSelection(.enabled)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(8)
                }
                .frame(height: 150)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
                .onChange(of: job.lines) { _, _ in     // compare contents, not count — the server caps lines at 500 (shift), so count goes constant on long jobs
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .onAppear {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(
            job.done ? Theme.border : Theme.accent.opacity(0.5)))
    }

    private func lineColor(_ line: String) -> Color {
        if line.contains("ERROR") || line.contains("✗") { return Theme.bad }
        if line.contains("✓") || line.contains("— จบ") { return Theme.good }
        if line.contains("http://") || line.contains("https://") { return Theme.accent }
        return .white.opacity(0.72)
    }
}
