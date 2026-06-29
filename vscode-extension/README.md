# Questassure VHDL Extension for VS Code

This extension integrates **Questassure** VHDL productivity tools directly into VS Code, providing syntax highlighting, real-time diagnostics, formatting, simulations, interactive schematics, and FSM design tools.

---

## 🚀 Installation & Prerequisites

To use this extension, you need **GHDL**, **Yosys**, and **Surfer** installed on your system.

### 1. macOS
Install all dependencies via Homebrew:
```bash
brew install ghdl yosys surfer
```

### 2. Linux
Install via your package manager:
```bash
sudo apt update && sudo apt install ghdl yosys
cargo install surfer
```

### 3. Windows
1. Download and extract [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) (bundles GHDL and Yosys).
2. Download [Surfer](https://github.com/surfer-project/surfer/releases).
3. Add the `bin` folder of OSS CAD Suite and the folder containing `surfer.exe` to your environment `PATH`:
   - Press the **Windows Key**, type `environment variables`, and select **Edit the system environment variables**.
   - Click **Environment Variables...**.
   - Under *User variables* or *System variables*, select **Path** and click **Edit...**.
   - Click **New** and add the absolute paths to those folders.
   - Click **OK** on all windows and restart VS Code.

---

## ✨ Key Features

### 1. Smart Editing & Formatting
* **Syntax Highlighting**: Custom Questassure VHDL theme.
* **Auto-Save**: Automatic save after 1000 ms of inactivity.
* **Real-time Diagnostics**: Linting with GHDL, sensitivity list checker, and latch detector.
* **Code Formatting**: 4-space indentation, colon alignment, and conditional `<=` alignment.

### 2. Visual Tools
* **Interactive FSM & RTL Schematic**: Renders logic gates and state diagrams from code with two-way cross-probing.
* **FSM Designer**: Graphically design, edit, and save FSMs directly as VHDL code.
* **Embedded Waveform Viewer**: Built-in SVG-based waveform panel with layout presets.

### 3. Test Explorer & LSP
* **Test Explorer**: Discovers and runs VHDL testbenches within VS Code's Testing panel.
* **Code Navigation**: Go to Definition (F12), Find References (Shift+F12), Document Outline.
* **Code Generators**: Port mapping autocomplete, component instantiation (from clipboard or project), and testbench/FSM templates.

---

## ⚙️ Settings

* `questassure.ghdlPath` (default: `"ghdl"`): Path to the GHDL executable.
* `questassure.stopTime` (default: `"1us"`): Default simulation stop time.
* `questassure.language` (default: `"auto"`): Extension language (`auto`, `en`, `fr`).
* `questassure.openWavesOnTestExplorerRun` (default: `true`): Auto-open waveforms on test run.

---

## 🛠️ Marketplace Installation

* **VS Code Marketplace**: Search for **Questassure VHDL** and click **Install**.
* **VSIX Package**: Open the Command Palette (`Ctrl+Shift+P`), choose **Extensions: Install from VSIX...**, and select your `.vsix` file.

---

## 📜 Credits & Requirements

* **GHDL**: Requires system installation and binary in `PATH` or configured path.
* **Yosys**: Requires system installation and binary in `PATH`.
* **Surfer**: Requires system installation and binary in `PATH`.
