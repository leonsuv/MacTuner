import AppKit
import Foundation
import UniformTypeIdentifiers

/// Exports a self-contained, zero-dependency interactive HTML calibration report
/// with ECU summary, KPI cards, and interactive Tuned/Original/Delta heatmap tables.
enum HTMLReportExporter {
    @MainActor
    static func generateHTML(for model: AppModel) -> String {
        let ecu = model.ecuIdentity
        let def = model.definition
        let now = DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .short)
        let editedBytes = model.activeBin.map { b in
            zip(b.bytes, b.openedSnapshot).reduce(0) { $0 + ($1.0 != $1.1 ? 1 : 0) }
        } ?? 0
        let csReport = model.checksumReport
        let csText = csReport == nil ? "—" : (csReport!.invalidCount == 0 ? "OK (\(csReport!.blocks.count) Blocks)" : "\(csReport!.invalidCount) Invalid")

        var changedTablesHTML = ""
        var scalarsHTML = ""
        var modifiedCount = 0

        if let def {
            for item in def.items where model.isChanged(item) {
                modifiedCount += 1
                let cat = item.categories.first.flatMap { def.categories[$0] } ?? ""
                switch item.kind {
                case .table(let xAxis, let yAxis):
                    changedTablesHTML += renderTableSection(item: item, xAxis: xAxis, yAxis: yAxis, category: cat, model: model)
                case .constant:
                    let orig = esc(model.text(item.data, item.scaling, Cell(r: 0, c: 0), original: true))
                    let cur = esc(model.text(item.data, item.scaling, Cell(r: 0, c: 0)))
                    let unit = esc(model.displayUnit(item.scaling.units))
                    scalarsHTML += "<tr><td>\(esc(item.title))</td><td class='muted'>\(esc(cat))</td><td class='mono'>\(orig) \(unit)</td><td class='mono accent'>\(cur) \(unit)</td></tr>\n"
                case .flag:
                    let orig = model.flagValue(item, original: true) ? "ON (1)" : "OFF (0)"
                    let cur = model.flagValue(item) ? "ON (1)" : "OFF (0)"
                    scalarsHTML += "<tr><td>\(esc(item.title))</td><td class='muted'>\(esc(cat))</td><td class='mono'>\(orig)</td><td class='mono accent'>\(cur)</td></tr>\n"
                case .patch:
                    scalarsHTML += "<tr><td>\(esc(item.title))</td><td class='muted'>\(esc(cat))</td><td class='mono'>Stock</td><td class='mono accent'>Patched</td></tr>\n"
                }
            }
        }

        let ecuChips = [
            ecu.ecuFamily.map { ("ECU", $0) },
            ecu.hardwareNumber.map { ("HW", $0.value) },
            ecu.softwareNumber.map { ("SW", $0.value) },
            ecu.oemPartNumber.map { ("OEM", $0.value) }
        ].compactMap { $0 }.map { "<div class='chip'><span>\(esc($0.0))</span><strong>\(esc($0.1))</strong></div>" }.joined()

        let scalarSection = scalarsHTML.isEmpty ? "" : """
        <section class="card">
          <h2>Modified Constants, Switches &amp; Patches</h2>
          <table class="summary-table">
            <thead><tr><th>Parameter</th><th>Category</th><th>Original</th><th>Tuned</th></tr></thead>
            <tbody>\(scalarsHTML)</tbody>
          </table>
        </section>
        """

        let emptyNote = (changedTablesHTML.isEmpty && scalarsHTML.isEmpty)
            ? "<section class='card'><p class='muted'>No modified XDF parameters detected against the comparison binary.</p></section>"
            : ""

        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>MacTuner Report — \(esc(model.binName))</title>
        <style>
          :root { --bg:#0d1016; --card:#151a23; --border:rgba(255,255,255,0.09); --text:#eef2f7; --muted:#94a3b8; --accent:#38bdf8; --changed:#fb923c; }
          * { box-sizing:border-box; }
          body { margin:0; padding:28px; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif; background:var(--bg); color:var(--text); }
          .wrap { max-width:1240px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
          header { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:12px; }
          h1 { margin:0; font-size:26px; letter-spacing:-0.02em; }
          h2 { margin:0 0 12px 0; font-size:16px; font-weight:600; }
          .muted { color:var(--muted); font-size:12px; }
          .mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
          .accent { color:var(--changed); font-weight:600; }
          .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
          .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }
          .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }
          .kpi-val { font-size:22px; font-weight:700; margin-top:4px; }
          .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
          .chip { background:rgba(255,255,255,0.05); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px; display:flex; gap:6px; }
          .chip span { color:var(--muted); }
          .toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
          .seg { display:inline-flex; background:rgba(255,255,255,0.06); border-radius:8px; padding:2px; }
          .seg button { border:none; background:transparent; color:var(--muted); padding:5px 10px; border-radius:6px; font-size:12px; cursor:pointer; }
          .seg button.active { background:var(--accent); color:#04111a; font-weight:600; }
          .scroll { overflow-x:auto; }
          table.heatmap { border-collapse:separate; border-spacing:2px; font-size:11px; width:max-content; }
          table.heatmap th { color:var(--muted); font-weight:500; padding:3px 6px; text-align:right; }
          table.heatmap td { padding:4px 6px; border-radius:4px; text-align:right; font-variant-numeric:tabular-nums; min-width:46px; }
          table.heatmap td.chg { outline:1.5px solid var(--changed); }
          table.summary-table { width:100%; border-collapse:collapse; font-size:13px; }
          table.summary-table th, table.summary-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
          table.summary-table th { color:var(--muted); font-size:11px; text-transform:uppercase; }
          footer { text-align:center; color:var(--muted); font-size:11px; padding:12px 0; }
        </style>
        </head>
        <body>
        <div class="wrap">
          <header>
            <div>
              <h1>MacTuner Calibration Report</h1>
              <div class="muted mono">\(esc(model.binName)) · \(model.bin.count / 1024) KB\(def.map { " · Definition: \(esc($0.title))" } ?? "")</div>
              <div class="chips">\(ecuChips)</div>
            </div>
            <div class="muted">Generated \(esc(now))</div>
          </header>

          <div class="kpis">
            <div class="card"><div class="kpi-label">Modified Parameters</div><div class="kpi-val" style="color:var(--accent)">\(modifiedCount)</div></div>
            <div class="card"><div class="kpi-label">Modified Bytes</div><div class="kpi-val" style="color:var(--changed)">\(editedBytes) B</div></div>
            <div class="card"><div class="kpi-label">Checksums</div><div class="kpi-val">\(esc(csText))</div></div>
            <div class="card"><div class="kpi-label">Binary Size</div><div class="kpi-val">\(model.bin.count / 1024) KB</div></div>
          </div>

          \(scalarSection)
          \(changedTablesHTML)
          \(emptyNote)

          <footer>Generated natively by MacTuner for macOS · Non-destructive byte-exact ECU calibration workbench</footer>
        </div>
        <script>
        function setMode(tableId, mode, btn) {
          const wrap = document.getElementById(tableId);
          wrap.querySelectorAll('.seg button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          wrap.querySelectorAll('td[data-v]').forEach(td => {
            if (mode === 'bin') td.textContent = td.dataset.v;
            else if (mode === 'orig') td.textContent = td.dataset.o;
            else td.textContent = td.dataset.d;
          });
        }
        </script>
        </body>
        </html>
        """
    }

    @MainActor
    static func exportInteractiveHTMLPanel(for model: AppModel) {
        let panel = NSSavePanel()
        panel.title = String(localized: "Interaktiven HTML-Bericht exportieren")
        panel.allowedContentTypes = [.html]
        let base = (model.binName as NSString).deletingPathExtension
        panel.nameFieldStringValue = "\(base)-Report.html"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let html = generateHTML(for: model)
        try? html.write(to: url, atomically: true, encoding: .utf8)
        NSWorkspace.shared.open(url)
    }

    @MainActor
    private static func renderTableSection(item: XDFItem, xAxis: Axis, yAxis: Axis, category: String, model: AppModel) -> String {
        let l = item.data
        let s = item.scaling
        let xs = model.axisLabels(xAxis, count: l.cols)
        let ys = model.axisLabels(yAxis, count: l.rows)
        let unit = model.displayUnit(s.units)
        let tid = "map_\(item.id)"

        var vals: [[Double]] = []
        var mn = Double.infinity, mx = -Double.infinity
        for r in 0..<l.rows {
            var row: [Double] = []
            for c in 0..<l.cols {
                let v = model.raw(l, Cell(r: r, c: c)).map(s.value(raw:)) ?? 0
                mn = min(mn, v); mx = max(mx, v)
                row.append(v)
            }
            vals.append(row)
        }
        let span = max(mx - mn, 1e-9)

        var thead = "<tr><th>\(esc(model.displayUnit(yAxis.scaling.units))) \\ \(esc(model.displayUnit(xAxis.scaling.units)))</th>"
        for c in 0..<l.cols { thead += "<th class='mono'>\(esc(xs[c]))</th>" }
        thead += "</tr>"

        var tbody = ""
        for r in 0..<l.rows {
            tbody += "<tr><th class='mono'>\(esc(ys[r]))</th>"
            for c in 0..<l.cols {
                let cell = Cell(r: r, c: c)
                let curText = model.text(l, s, cell)
                let origText = model.text(l, s, cell, original: true)
                let curVal = vals[r][c]
                let origVal = model.raw(l, cell, original: true).map(s.value(raw:)) ?? curVal
                let delta = curVal - origVal
                let deltaText = abs(delta) < 1e-9 ? "0" : String(format: "%+.\(s.decimals)f", delta)
                let chg = model.isChanged(l, cell)
                let t = (curVal - mn) / span
                let bg = heatHex(t)
                let cls = chg ? " class='mono chg'" : " class='mono'"
                tbody += "<td\(cls) style='background:\(bg);color:#f8fafc' data-v='\(esc(curText))' data-o='\(esc(origText))' data-d='\(esc(deltaText))'>\(esc(curText))</td>"
            }
            tbody += "</tr>"
        }

        return """
        <section class="card" id="\(tid)">
          <div class="toolbar">
            <div>
              <h2 style="margin:0">\(esc(item.title))</h2>
              <div class="muted mono">\(String(format: "0x%05X", l.address)) · \(l.rows)×\(l.cols) · \(l.bits)-bit\(unit.isEmpty ? "" : " · \(esc(unit))")\(category.isEmpty ? "" : " · \(esc(category))")</div>
            </div>
            <div class="seg">
              <button class="active" onclick="setMode('\(tid)','bin',this)">Tuned</button>
              <button onclick="setMode('\(tid)','orig',this)">Original</button>
              <button onclick="setMode('\(tid)','delta',this)">Δ Delta</button>
            </div>
          </div>
          <div class="scroll"><table class="heatmap"><thead>\(thead)</thead><tbody>\(tbody)</tbody></table></div>
        </section>
        """
    }

    private static func heatHex(_ t: Double) -> String {
        let clamped = max(0, min(1, t))
        // Clean Viridis-inspired dark-readable ramp
        let r = Int(round((0.12 + 0.78 * pow(clamped, 1.4)) * 255))
        let g = Int(round((0.28 + 0.42 * sin(clamped * .pi)) * 255))
        let b = Int(round((0.68 - 0.50 * clamped) * 255))
        return String(format: "rgb(%d,%d,%d)", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }

    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
         .replacingOccurrences(of: "\"", with: "&quot;")
         .replacingOccurrences(of: "'", with: "&#39;")
    }
}
