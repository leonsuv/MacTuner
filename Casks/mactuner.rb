cask "mactuner" do
  version "4.0.0"
  sha256 :no_check

  url "https://github.com/leonsuv/MacTuner/releases/download/v#{version}/MacTuner-#{version}.zip"
  name "MacTuner"
  desc "Cross-platform ECU & TCU calibration workbench for TunerPro XDF, A2L, and ECU binaries"
  homepage "https://github.com/leonsuv/MacTuner"

  depends_on macos: ">= :sonoma"

  app "MacTuner.app"

  zap trash: [
    "~/Library/Application Support/MacTuner",
    "~/Library/Application Support/de.azendix.mactuner",
    "~/Library/Preferences/local.mactuner.plist",
    "~/Library/Preferences/de.azendix.mactuner.plist",
  ]
end
