# Questassure VHDL Extension for VS Code

[![Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Questassure-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode)

The official extension is available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode).

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

### 4. 🤖 Model Context Protocol (MCP) Server for AI Assistants
* **Universal EDA Tooling for LLMs**: Connects AI models (Claude, Antigravity, Cursor, Windsurf, Codex...) directly to GHDL, Yosys, and VCD simulation waveform engines.
* **11 Native MCP Tools**: Testbench simulation, VCD waveform inspection, project-wide test runner, GHDL linting & type checks, DRC hazard & latch detection, Yosys resource estimation, FSM analysis & Mermaid diagrams, testbench scaffolding, and VHDL formatting.
* **Resources & Prompts**: Pre-packaged hardware guidelines and AI workflows for automated testbench authoring, simulation debugging, and FSM synthesis.
* **One-Click Config Export**: Run `Questassure: Copy MCP Configuration for AI Assistants` in VS Code to get instant, ready-to-paste configurations for any client.

---

## 🤖 Model Context Protocol (MCP) Setup & Architecture

### What is Model Context Protocol (MCP)?
The **Model Context Protocol (MCP)** is an open standard developed to enable Large Language Models (LLMs) to securely access local tools, file systems, and real-time execution environments. 

Rather than having an AI hallucinate VHDL simulation results or guess signal timing, the Questassure MCP Server empowers AI assistants to:
1. **Compile and execute** simulations with GHDL in real-time.
2. **Inspect waveforms (VCD)** at exact clock cycles and timestamps.
3. **Run Design Rule Checks (DRC)** to eliminate inferred latches and missing sensitivity signals.
4. **Synthesize circuits with Yosys** to estimate gate counts and flip-flops (DFF).

```
+-----------------------------------------------------------------------+
|                       AI Clients / IDEs                               |
|   Claude Desktop  |  Cursor  |  Antigravity  |  Windsurf  |  Copilot  |
+-----------------------------------------------------------------------+
                                  | (JSON-RPC 2.0 via stdio)
                                  v
+-----------------------------------------------------------------------+
|                    Questassure MCP Server                             |
|                    (dist/mcp-server.js)                               |
+-----------------------------------------------------------------------+
         |                       |                      |
         v                       v                      v
   GHDL Engine             Yosys Synthesis        VCD Waveform & DRC
(Simulate & Lint)        (Resource Estimate)     (Inspect & Analyze)
```

---

### 📦 Quick Setup for Famous AI Clients

You can generate your configuration directly inside VS Code by opening the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and selecting:
> **`Questassure: Copy MCP Configuration for AI Assistants (Claude, Cursor, Antigravity...)`**

Alternatively, configure your favorite AI client manually:

#### 1. Claude Desktop
Edit your `claude_desktop_config.json`:
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 2. Cursor IDE
Add to your project's `.cursor/mcp.json` or in **Cursor Settings > Features > MCP**:
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 3. Google Antigravity / Gemini Code Assist
Add to your Antigravity MCP settings or tool definitions:
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 4. Windsurf (Codeium)
Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 5. Roo Code / Cline / Generic MCP Clients
```json
{
  "name": "questassure",
  "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/questassure-vscode/dist/mcp-server.js"],
  "transport": "stdio"
}
```

---

### 🛠️ Available MCP Tools

| MCP Tool | Description |
| :--- | :--- |
| `simulate_testbench` | Compiles & runs a testbench with GHDL, returns simulation logs, assertions, and VCD path. |
| `inspect_waveform` | Reads a `.vcd` waveform file and returns exact signal transitions across a time window. |
| `run_project_tests` | Automatically discovers and executes all testbenches in the project with pass/fail summary. |
| `check_syntax_and_types` | Performs real-time GHDL syntax and dependency checks with line/col diagnostics. |
| `detect_hardware_hazards` | Runs Questassure DRC: detects inferred latches, incomplete sensitivity lists, and dead code. |
| `synthesize_and_estimate_resources` | Synthesizes design with Yosys, estimates DFFs, LUTs, gates, and checks synthesizability. |
| `get_project_hierarchy` | Returns AST & dependency map of all entities, architectures, packages, and testbenches. |
| `get_entity_interface` | Parses entity ports (name, direction, type), generics, and documentation headers. |
| `analyze_fsm` | Analyzes Finite State Machines, extracts transition matrices, and generates Mermaid diagrams. |
| `generate_testbench` | Generates a complete VHDL testbench scaffold with clock, reset, and stimulus template. |
| `format_vhdl` | Automatically formats and aligns VHDL source code according to Questassure standards. |

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

