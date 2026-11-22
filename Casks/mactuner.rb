cask "mactuner" do
  version "2.3.1"
  sha256 :no_check

  url "https://github.com/leonsuv/MacTuner/releases/download/v#{version}/MacTuner-#{version}.zip"
  name "MacTuner"
  desc "Native macOS editor for TunerPro XDF definitions and ECU binaries"
  homepage "https://github.com/leonsuv/MacTuner"

  depends_on macos: ">= :sonoma"

  app "MacTuner.app"
  binary "#{appdir}/MacTuner.app/Contents/MacOS/MacTuner", target: "mactuner"

  zap trash: [
    "~/Library/Application Support/MacTuner",
    "~/Library/Preferences/local.mactuner.plist",
  ]
end
