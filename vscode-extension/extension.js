const vscode = require('vscode');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { l } = require('./l10n');

const formatterModule = require('./formatter');
const projectModule = require('./project');
const ghdlModule = require('./ghdl');
const rtlExtractorModule = require('./rtl_extractor');
const testExplorerModule = require('./test_explorer');
const lspProvidersModule = require('./lsp_providers');
const codeGeneratorsModule = require('./code_generators');
const staticAnalyzerModule = require('./static_analyzer');

let diagnosticCollection;
let outputChannel;

/**
 * Récupère la configuration utilisateur pour GHDL (chemin de l'exécutable et durée de simulation par défaut).
 *
 * @returns {Object} Un objet contenant { ghdlPath, stopTime }.
 */
function getGhdlConfig() {
    const config = vscode.workspace.getConfiguration('questassure');
    const ghdlPath = config.get('ghdlPath') || 'ghdl';
    const stopTime = config.get('stopTime') || '1us';
    return {
        ghdlPath,
        stopTime
    };
}

/**
 * Configure les couleurs de coloration syntaxique VHDL globales dans VS Code
 * en ciblant les scopes TextMate spécifiques à VHDL.
 */
async function configureVhdlColors() {
    try {
        // 1. Clean up invalid/unsupported language-specific token customizations from previous attempts
        const vhdlConfig = vscode.workspace.getConfiguration('editor', { languageId: 'vhdl' });
        const vhdlInspect = vhdlConfig.inspect('tokenColorCustomizations') || {};
        if (vhdlInspect.globalLanguageValue) {
            await vhdlConfig.update('tokenColorCustomizations', undefined, vscode.ConfigurationTarget.Global, true);
        }

        // 2. Configure VHDL token colors globally (but target only VHDL-specific TextMate scopes)
        const config = vscode.workspace.getConfiguration('editor');
        const currentCustomizations = config.inspect('tokenColorCustomizations') || {};
        
        const questassureRules = [
            { scope: "keyword.control.vhdl", settings: { foreground: "#569cd6", fontStyle: "bold" } },
            { scope: "keyword.operator.vhdl", settings: { foreground: "#d4d4d4" } },
            { scope: "storage.type.vhdl", settings: { foreground: "#4ec9b0", fontStyle: "bold" } },
            { scope: "string.quoted.double.vhdl", settings: { foreground: "#ce9178" } },
            { scope: "string.quoted.single.vhdl", settings: { foreground: "#ce9178" } },
            { scope: "constant.numeric.vhdl", settings: { foreground: "#b5cea8" } },
            { scope: "comment.line.double-dash.vhdl", settings: { foreground: "#6a9955", fontStyle: "italic" } }
        ];

        let targetCustomizations = currentCustomizations.globalValue || {};
        let textMateRules = targetCustomizations.textMateRules || [];

        let needsUpdate = false;
        for (const rule of questassureRules) {
            const existingRule = textMateRules.find(r => r.scope === rule.scope);
            if (!existingRule || 
                existingRule.settings.foreground !== rule.settings.foreground || 
                existingRule.settings.fontStyle !== rule.settings.fontStyle) {
                needsUpdate = true;
                break;
            }
        }

        if (needsUpdate) {
            const updatedRules = [...textMateRules];
            for (const rule of questassureRules) {
                const idx = updatedRules.findIndex(r => r.scope === rule.scope);
                if (idx !== -1) {
                    updatedRules[idx] = rule;
                } else {
                    updatedRules.push(rule);
                }
            }

            const newCustomizations = {
                ...targetCustomizations,
                textMateRules: updatedRules
            };

            await config.update('tokenColorCustomizations', newCustomizations, vscode.ConfigurationTarget.Global);
        }
    } catch (err) {
        console.error('Failed to configure Questassure VHDL token colors:', err);
    }
}

/**
 * Ajoute un rectangle d'arrière-plan blanc au début du contenu SVG pour améliorer la lisibilité
 * dans les thèmes sombres de VS Code.
 *
 * @param {string} svgContent - Le contenu du fichier SVG brut.
 * @returns {string} Le contenu SVG modifié avec un fond blanc.
 */
function addWhiteBackgroundToSvg(svgContent) {
    const svgOpenMatch = svgContent.match(/<svg[^>]*>/);
    if (!svgOpenMatch) {
        return svgContent;
    }
    const openTag = svgOpenMatch[0];
    const insertIdx = svgContent.indexOf(openTag) + openTag.length;
    const bgRect = '\n  <rect width="100%" height="100%" fill="white" stroke="none"/>';
    return svgContent.slice(0, insertIdx) + bgRect + svgContent.slice(insertIdx);
}

/**
 * Extrait les types énumérés (et la correspondance entre les signaux et leurs états) du projet
 * pour permettre un affichage convivial des états des FSM (noms au lieu de valeurs binaires)
 * dans le visualisateur d'ondes.
 *
 * @param {VhdlProject} project - Projet de référence.
 * @returns {Object} Dictionnaire associant les signaux à leurs listes de valeurs énumérées.
 */
function extractEnumMap(project) {
    const enumMap = {};
    const typeToStates = {};
    if (!project || !project.files) return enumMap;

    for (const file of project.files) {
        if (!fs.existsSync(file)) continue;
        try {
            const content = fs.readFileSync(file, 'utf8');
            const cleanContent = content.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

            // 1. Find enum types
            const typeRegex = /\btype\s+(\w+)\s+is\s*\(([\s\S]*?)\)\s*;/gi;
            let tm;
            while ((tm = typeRegex.exec(cleanContent)) !== null) {
                const typeName = tm[1].toLowerCase();
                const states = tm[2].split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
                if (states.length > 0) {
                    typeToStates[typeName] = states;
                }
            }

            // 2. Find signals
            const declRegex = /\b(signal|variable)\s+([a-zA-Z0-9_,\s]+)\s*:\s*(\w+)\b/gi;
            let dm;
            while ((dm = declRegex.exec(cleanContent)) !== null) {
                const typeName = dm[3].toLowerCase();
                if (typeToStates[typeName]) {
                    const signals = dm[2].split(',').map(s => s.trim().toLowerCase());
                    for (const sig of signals) {
                        enumMap[sig] = typeToStates[typeName];
                    }
                }
            }
        } catch (e) {
            console.error("Failed to extract enums from " + file, e);
        }
    }
    return enumMap;
}

/**
 * Ouvre un panneau Webview interactif pour visualiser des chronogrammes VCD.
 * Charge les données d'ondes, gère l'enregistrement/chargement de presets de signaux,
 * et permet de comparer avec un fichier VCD de référence.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 * @param {string} vcdPath - Le chemin absolu du fichier VCD.
 * @param {string} entityName - Le nom de l'entité de testbench associée.
 * @param {VhdlProject|null} project - Projet de référence, ou null.
 * @returns {vscode.WebviewPanel} Le panneau Webview créé.
 */
function openWaveformWebview(context, vcdPath, entityName, project = null) {
    const panel = vscode.window.createWebviewPanel(
        'questassureWaveform',
        l('wave.panel.title', entityName),
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );

    const htmlPath = path.join(context.extensionPath, 'waveform_webview.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    panel.webview.html = html;

    const loadWaveData = () => {
        if (!fs.existsSync(vcdPath)) return;
        const vcdData = fs.readFileSync(vcdPath, 'utf8');
        const preset = context.workspaceState.get('waveform_presets_' + entityName) || [];
        const enumMap = extractEnumMap(project);
        panel.webview.postMessage({
            command: 'loadVcd',
            vcd: vcdData,
            preset: preset,
            enumMap: enumMap
        });
    };

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'ready') {
            loadWaveData();
        } else if (message.command === 'savePreset') {
            await context.workspaceState.update('waveform_presets_' + entityName, message.signals);
            vscode.window.showInformationMessage(l('wave.preset.saved'));
        } else if (message.command === 'loadPreset') {
            const signals = context.workspaceState.get('waveform_presets_' + entityName) || [];
            panel.webview.postMessage({
                command: 'applyPreset',
                signals: signals
            });
            vscode.window.showInformationMessage(l('wave.preset.loaded'));
        } else if (message.command === 'selectReferenceVcd') {
            const options = {
                canSelectMany: false,
                openLabel: 'Sélectionner le VCD de référence',
                filters: {
                    'VCD Files': ['vcd']
                }
            };
            vscode.window.showOpenDialog(options).then(fileUris => {
                if (fileUris && fileUris[0]) {
                    const filePath = fileUris[0].fsPath;
                    try {
                        const vcdContent = fs.readFileSync(filePath, 'utf8');
                        panel.webview.postMessage({
                            command: 'loadReferenceVcd',
                            vcd: vcdContent,
                            fileName: path.basename(filePath)
                        });
                    } catch (err) {
                        vscode.window.showErrorMessage("Impossible de lire le fichier VCD : " + err.message);
                    }
                }
            });
        } else if (message.command === 'showError') {
            vscode.window.showErrorMessage(message.message);
        }
    });

    return panel;
}

/**
 * Point d'entrée principal : Activé lorsque l'extension est chargée par VS Code.
 * Enregistre les fournisseurs LSP, les commandes utilisateur (compilation, simulation,
 * visualisations RTL et ondes), configure les abonnements aux événements d'ouverture/sauvegarde
 * pour déclencher le linter et DRC, et initialise le Test Explorer.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 */
function activate(context) {
    configureVhdlColors();

    diagnosticCollection = vscode.languages.createDiagnosticCollection('questassure');
    context.subscriptions.push(diagnosticCollection);
    
    outputChannel = vscode.window.createOutputChannel('Questassure Simulation');
    context.subscriptions.push(outputChannel);

    // Initialize Test Explorer
    testExplorerModule.initTestExplorer(context, outputChannel);

    // Register Inline Waveform Opener Command
    const openWaveformInlineCommand = vscode.commands.registerCommand('questassure.openWaveformInline', (vcdPath, tbName, projectDir) => {
        const project = projectDir ? projectModule.VhdlProject.discover(projectDir) : null;
        openWaveformWebview(context, vcdPath, tbName, project);
    });
    context.subscriptions.push(openWaveformInlineCommand);

    // Initialize LSP Providers
    lspProvidersModule.registerLspProviders(context);

    // Initialize Code Generators
    codeGeneratorsModule.registerCodeGenerators(context);

    // 1. Register Document Formatter
    const formatter = vscode.languages.registerDocumentFormattingEditProvider('vhdl', {
        provideDocumentFormattingEdits(document) {
            try {
                const text = document.getText();
                const formatted = formatterModule.formatVhdl(text);
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );
                return [vscode.TextEdit.replace(fullRange, formatted)];
            } catch (error) {
                vscode.window.showErrorMessage(l('formatter.failed', error.message));
                return [];
            }
        }
    });
    context.subscriptions.push(formatter);

    // 2. Linting on file open and save
    const triggerLint = async (document) => {
        if (document.languageId !== 'vhdl') {
            return;
        }
        
        const filePath = document.uri.fsPath;
        const { ghdlPath } = getGhdlConfig();
        
        let result;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            try {
                const project = projectModule.VhdlProject.discover(rootPath);
                project.add_file(filePath);
                result = await ghdlModule.analyzeFileInProject(ghdlPath, project, filePath);
            } catch (e) {
                console.error(`Project load failed, falling back to syntax check: ${e.message}`);
                result = await ghdlModule.checkSyntaxOnly(ghdlPath, filePath);
            }
        } else {
            result = await ghdlModule.checkSyntaxOnly(ghdlPath, filePath);
        }
        
        try {
            // Group diagnostics by file
            const diagMap = new Map();
            
            for (const diag of result.diagnostics) {
                const targetFile = diag.file ? vscode.Uri.file(diag.file) : document.uri;
                const line = Math.max(0, (diag.line || 1) - 1);
                const column = Math.max(0, (diag.column || 1) - 1);
                
                let severity = vscode.DiagnosticSeverity.Error;
                if (diag.severity === 'warning') {
                    severity = vscode.DiagnosticSeverity.Warning;
                } else if (diag.severity === 'info') {
                    severity = vscode.DiagnosticSeverity.Information;
                }
                
                const range = new vscode.Range(line, column, line, column + 20); // highlight a small token
                const vsDiag = new vscode.Diagnostic(range, diag.message, severity);
                vsDiag.source = 'GHDL';
                
                if (!diagMap.has(targetFile.toString())) {
                    diagMap.set(targetFile.toString(), { uri: targetFile, list: [] });
                }
                diagMap.get(targetFile.toString()).list.push(vsDiag);
            }
            
            // Clear and update diagnostic collection
            diagnosticCollection.clear();
            for (const group of diagMap.values()) {
                diagnosticCollection.set(group.uri, group.list);
            }
            
            // If there are no diagnostics for the active document, clear it explicitly
            if (!diagMap.has(document.uri.toString())) {
                diagnosticCollection.set(document.uri, []);
            }

            // Run custom DRC static analysis linter
            staticAnalyzerModule.runDrcLinter(document, diagnosticCollection);
            
        } catch (e) {
            console.error(`Failed to parse linting JSON: ${e.message}`);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(triggerLint),
        vscode.workspace.onDidOpenTextDocument(triggerLint)
    );

    // Run lint on all currently visible VHDL editors
    vscode.window.visibleTextEditors.forEach(editor => {
        if (editor.document) {
            triggerLint(editor.document);
        }
    });

    // 3. Command to Run Testbench
    const runTestbenchCommand = vscode.commands.registerCommand('questassure.runTestbench', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage(l('sim.no_active_editor'));
            return;
        }

        const activeFile = activeEditor.document.uri.fsPath;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const projectDir = (workspaceFolders && workspaceFolders.length > 0)
            ? workspaceFolders[0].uri.fsPath
            : path.dirname(activeFile);
        
        // 1. Discover VHDL testbenches via JS
        let testbenches = [];
        try {
            const project = projectModule.VhdlProject.discover(projectDir);
            testbenches = project.find_testbenches().map(tb => ({
                name: tb[0],
                file: tb[1]
            }));
        } catch (e) {
            console.error("Failed to discover testbenches", e);
        }
        
        // 2. Build selection items
        const quickPickItems = testbenches.map(tb => ({
            label: tb.name,
            description: path.basename(tb.file),
            detail: tb.file
        }));
        quickPickItems.push({ label: l('sim.enter_tb_manual'), description: "" });
        
        const selectedTb = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: l('sim.select_tb')
        });
        if (!selectedTb) return; // User cancelled
        
        let tbName;
        if (selectedTb.label === l('sim.enter_tb_manual')) {
            tbName = await vscode.window.showInputBox({
                prompt: l('sim.prompt_tb_name'),
                placeHolder: l('sim.placeholder_tb_name')
            });
        } else {
            tbName = selectedTb.label;
        }
        if (!tbName || !tbName.trim()) return;
        
        const { stopTime, ghdlPath } = getGhdlConfig();
        
        // 3. Prompt for simulation stop time
        const simTime = await vscode.window.showInputBox({
            prompt: l('sim.prompt_stop_time'),
            value: stopTime,
            placeHolder: l('sim.placeholder_stop_time')
        });
        if (!simTime || !simTime.trim()) return;
        
        // 4. Prompt for work library name
        const libName = await vscode.window.showInputBox({
            prompt: l('sim.prompt_work_lib'),
            value: "work",
            placeHolder: l('sim.placeholder_work_lib')
        });
        if (!libName || !libName.trim()) return;
        
        // 5. Run simulation with gathered details
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine(l('sim.log.starting', projectDir));
        outputChannel.appendLine(l('sim.log.tb', tbName));
        outputChannel.appendLine(l('sim.log.stop_time', simTime));
        outputChannel.appendLine(l('sim.log.lib', libName));
        outputChannel.appendLine(l('sim.log.compiling'));
        
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: l('sim.progress.title', tbName),
            cancellable: false
        }, async (progress) => {
            try {
                const project = projectModule.VhdlProject.discover(projectDir);
                project.update_library_for_simulation(libName, tbName);
                project.save();

                const simRun = await ghdlModule.runTestbench(ghdlPath, project, tbName, simTime, libName);
                const result = simRun.result;
                const wavePath = simRun.wavePath;

                outputChannel.appendLine(l('sim.log.stdout_header'));
                outputChannel.appendLine(result.stdout || '(no stdout)');
                outputChannel.appendLine(l('sim.log.stderr_header'));
                outputChannel.appendLine(result.stderr || '(no stderr)');
                
                if (result.ok) {
                    outputChannel.appendLine(l('sim.log.success'));
                    if (simRun.vcdPath) {
                        outputChannel.appendLine(l('sim.log.waves', simRun.vcdPath));
                        openWaveformWebview(context, simRun.vcdPath, tbName, project);
                    } else if (wavePath) {
                        outputChannel.appendLine(l('sim.log.waves', wavePath));
                        
                        const questassureRoot = path.resolve(__dirname, '..');
                        let surferCmd = 'surfer';
                        const bundledSurferMac = path.join(questassureRoot, 'bin', 'surfer');
                        const bundledSurferWin = path.join(questassureRoot, 'bin', 'surfer.exe');
                        
                        if (process.platform === 'win32' && fs.existsSync(bundledSurferWin)) {
                            surferCmd = `"${bundledSurferWin}"`;
                        } else if (fs.existsSync(bundledSurferMac)) {
                            surferCmd = `"${bundledSurferMac}"`;
                        }
                        
                        outputChannel.appendLine(l('sim.log.launching_surfer', `${surferCmd} "${wavePath}"`));
                        
                        exec(`${surferCmd} "${wavePath}"`, (launchError) => {
                            if (launchError) {
                                outputChannel.appendLine(l('sim.log.surfer_launch_warning', launchError.message));
                                vscode.window.showInformationMessage(
                                    l('sim.msg.surfer_failed'),
                                    l('sim.btn.copy_path')
                                ).then(selection => {
                                    if (selection === l('sim.btn.copy_path')) {
                                        vscode.env.clipboard.writeText(wavePath);
                                    }
                                });
                            } else {
                                outputChannel.appendLine(l('sim.log.surfer_success'));
                                vscode.window.showInformationMessage(l('sim.msg.surfer_success'));
                            }
                        });
                    } else {
                        vscode.window.showInformationMessage(l('sim.msg.success_no_waves'));
                    }
                } else {
                    outputChannel.appendLine(l('sim.log.failed', result.returncode));
                    vscode.window.showErrorMessage(l('sim.msg.failed'));
                }
                
                // Update diagnostics with compile errors from simulation
                if (result.diagnostics && result.diagnostics.length > 0) {
                    const diagMap = new Map();
                    for (const diag of result.diagnostics) {
                        if (!diag.file) continue;
                        const fileUri = vscode.Uri.file(diag.file);
                        const line = Math.max(0, (diag.line || 1) - 1);
                        const column = Math.max(0, (diag.column || 1) - 1);
                        
                        const range = new vscode.Range(line, column, line, column + 20);
                        const vsDiag = new vscode.Diagnostic(range, diag.message, vscode.DiagnosticSeverity.Error);
                        vsDiag.source = 'GHDL Simulation';
                        
                        if (!diagMap.has(fileUri.toString())) {
                            diagMap.set(fileUri.toString(), { uri: fileUri, list: [] });
                        }
                        diagMap.get(fileUri.toString()).list.push(vsDiag);
                    }
                    
                    for (const group of diagMap.values()) {
                        diagnosticCollection.set(group.uri, group.list);
                    }
                }
            } catch (e) {
                outputChannel.appendLine(l('sim.log.run_failed', e.message));
                vscode.window.showErrorMessage(l('sim.msg.run_failed'));
            }
        });
    });
    context.subscriptions.push(runTestbenchCommand);

    // 4. Command to compile a specific file (opening it triggers linting/compilation)
    const compileFileCommand = vscode.commands.registerCommand('questassure.compileFile', (filePath) => {
        vscode.workspace.openTextDocument(filePath).then((doc) => {
            vscode.window.showTextDocument(doc);
            triggerLint(doc);
        });
    });
    context.subscriptions.push(compileFileCommand);

    // 5. Quick Fix CodeActionsProvider for VHDL dependency errors
    const codeActionProvider = vscode.languages.registerCodeActionsProvider('vhdl', {
        provideCodeActions(document, range, contextInfo) {
            const actions = [];
            for (const diagnostic of contextInfo.diagnostics) {
                const match = diagnostic.message.match(/Dependency '(.*?)' at (.*?) has errors\./) ||
                              diagnostic.message.match(/La dépendance '(.*?)' à (.*?) contient des erreurs\./);
                if (match) {
                    const depName = match[1];
                    const depPath = match[2];
                    
                    const action = new vscode.CodeAction(l('codeaction.compile_dep', depName), vscode.CodeActionKind.QuickFix);
                    action.command = {
                        command: 'questassure.compileFile',
                        title: l('codeaction.compile_dep_title', depName),
                        arguments: [depPath]
                    };
                    action.diagnostics = [diagnostic];
                    action.isPreferred = true;
                    
                    actions.push(action);
                }
            }
            return actions;
        }
    });
    context.subscriptions.push(codeActionProvider);

    // 6. Show RTL Schematic / FSM diagram in Webview
    let activeRtlPanel = null;

    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!activeRtlPanel || event.textEditor.document.languageId !== 'vhdl') {
            return;
        }
        const document = event.textEditor.document;
        const position = event.textEditor.selection.active;
        const wordRange = document.getWordRangeAtPosition(position);
        if (wordRange) {
            const word = document.getText(wordRange).trim();
            activeRtlPanel.webview.postMessage({
                command: 'highlightState',
                state: word,
                center: false
            });
        }
    });
    context.subscriptions.push(selectionChangeListener);

    const showRTLCommand = vscode.commands.registerCommand('questassure.showRTL', (targetFilePath, targetEntityName) => {
        let filePath = targetFilePath;
        let entityName = targetEntityName;

        if (filePath && typeof filePath === 'object') {
            if (filePath.fsPath) {
                filePath = filePath.fsPath;
            } else if (filePath.path) {
                filePath = filePath.path;
            }
        }

        if (!filePath) {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.languageId !== 'vhdl') {
                vscode.window.showWarningMessage(l('rtl.no_active_editor'));
                return;
            }
            filePath = activeEditor.document.uri.fsPath;
        }
        
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: l('rtl.progress.extracting', path.basename(filePath)),
            cancellable: false
        }, async (progress) => {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                if (!entityName) {
                    const entityMatch = /\bentity\s+(\w+)\s+is\b/i.exec(content);
                    if (!entityMatch) {
                        throw new Error(l('rtl.err.no_entity'));
                    }
                    entityName = entityMatch[1];
                }

                const extractor = new rtlExtractorModule.RtlExtractor(content);
                
                let svgContent;
                let mermaidContent = "";
                let netlistObj = null;
                let bitToNetName = {};
                
                // Always use default GHDL/Yosys pipeline to show RTL schematic
                const { ghdlPath } = getGhdlConfig();
                let project = null;
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const rootPath = workspaceFolders[0].uri.fsPath;
                    try {
                        project = projectModule.VhdlProject.discover(rootPath);
                        project.add_file(filePath);
                    } catch (e) {}
                }
                const rtlRes = await ghdlModule.generateRtlSvg(ghdlPath, project, filePath, entityName);
                svgContent = addWhiteBackgroundToSvg(rtlRes.svg);
                netlistObj = rtlRes.netlist;
                
                if (netlistObj && netlistObj.modules) {
                    const moduleNames = Object.keys(netlistObj.modules);
                    if (moduleNames.length > 0) {
                        const mod = netlistObj.modules[moduleNames[0]];
                        for (const netName in mod.netnames) {
                            let cleanName = netName;
                            if (cleanName.startsWith('\\')) cleanName = cleanName.substring(1);
                            if (cleanName.startsWith('$')) continue;
                            const net = mod.netnames[netName];
                            for (const bit of net.bits) {
                                if (typeof bit === 'number') {
                                    bitToNetName[bit] = cleanName;
                                }
                            }
                        }
                    }
                }

                try {
                    mermaidContent = extractor.generateMermaid();
                } catch (e) {}

                const activeFileUri = vscode.Uri.file(filePath);

                // Create Webview Panel
                const panel = vscode.window.createWebviewPanel(
                    'questassureRtl',
                    l('rtl.panel.title', entityName),
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [vscode.Uri.file(context.extensionPath)]
                    }
                );
                
                panel.hierarchyStack = [{ entityName, filePath }];
                activeRtlPanel = panel;
                
                panel.onDidDispose(() => {
                    if (activeRtlPanel === panel) {
                        activeRtlPanel = null;
                    }
                });

                const htmlPath = path.join(context.extensionPath, 'schematic_webview.html');
                const html = fs.readFileSync(htmlPath, 'utf8');
                panel.webview.html = html;

                panel.webview.onDidReceiveMessage(async (message) => {
                    if (message.command === 'ready') {
                        panel.webview.postMessage({
                            command: 'loadSvg',
                            svg: svgContent,
                            mermaid: mermaidContent,
                            netlist: netlistObj,
                            bitToNetName: bitToNetName,
                            hierarchyStack: panel.hierarchyStack
                        });
                    } else if (message.command === 'exportSvg') {
                        const bgChoice = await vscode.window.showQuickPick([
                            { label: "Fond transparent (Transparent background)", value: "transparent" },
                            { label: "Fond blanc (White background)", value: "white" }
                        ], { placeHolder: "Choisissez le type d'arrière-plan pour l'export SVG" });
                        
                        if (!bgChoice) return;

                        let finalSvg = message.svg;
                        if (bgChoice.value === 'transparent') {
                            // Strip background rect from SVG string
                            finalSvg = finalSvg.replace(/<rect[^>]+fill="#ffffff"[^>]*\/>/gi, '');
                            finalSvg = finalSvg.replace(/<rect[^>]+fill="white"[^>]*\/>/gi, '');
                        }

                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '', `${entityName}_schematic.svg`)),
                            filters: { 'SVG Files': ['svg'] }
                        });
                        if (uri) {
                            try {
                                fs.writeFileSync(uri.fsPath, finalSvg, 'utf8');
                                vscode.window.showInformationMessage(l('rtl.export.success'));
                            } catch (e) {
                                vscode.window.showErrorMessage(l('rtl.export.error', e.message));
                            }
                        }
                    } else if (message.command === 'copyMermaid') {
                        await vscode.env.clipboard.writeText(message.mermaid);
                        vscode.window.showInformationMessage(l('rtl.mermaid.success'));
                    } else if (message.command === 'selectState') {
                        try {
                            const currentFile = panel.hierarchyStack[panel.hierarchyStack.length - 1].filePath;
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(currentFile));
                            const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                            
                            const text = doc.getText();
                            const stateName = message.state;
                            const patterns = [
                                new RegExp(`\\bwhen\\s+${stateName}\\b`, 'i'),
                                new RegExp(`\\b${stateName}\\s*=>`, 'i'),
                                new RegExp(`\\btype\\s+\\w+\\s+is\\s*\\([\\s\\S]*?\\b${stateName}\\b`, 'i'),
                                new RegExp(`\\b${stateName}\\b`, 'i')
                            ];
                            let match = null;
                            for (const pat of patterns) {
                                match = pat.exec(text);
                                if (match) break;
                            }
                            if (match) {
                                const pos = doc.positionAt(match.index);
                                ed.selection = new vscode.Selection(pos, pos);
                                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                                
                                // Echo highlight
                                panel.webview.postMessage({
                                    command: 'highlightState',
                                    state: stateName,
                                    center: true
                                });
                            }
                        } catch (err) {
                            console.error("Failed to select state in editor:", err);
                        }
                    } else if (message.command === 'selectSignal') {
                        try {
                            const currentFile = panel.hierarchyStack[panel.hierarchyStack.length - 1].filePath;
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(currentFile));
                            const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                            
                            const text = doc.getText();
                            const sigName = message.signal;
                            const patterns = [
                                new RegExp(`\\bsignal\\s+[^:]*?\\b${sigName}\\b`, 'i'),
                                new RegExp(`\\b${sigName}\\s*<=`, 'i'),
                                new RegExp(`\\b${sigName}\\b`, 'i')
                            ];
                            let match = null;
                            for (const pat of patterns) {
                                match = pat.exec(text);
                                if (match) break;
                            }
                            if (match) {
                                const pos = doc.positionAt(match.index);
                                ed.selection = new vscode.Selection(pos, pos);
                                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                                
                                panel.webview.postMessage({
                                    command: 'highlightSignal',
                                    signal: sigName
                                });
                            }
                        } catch (err) {
                            console.error("Failed to select signal in editor:", err);
                        }
                    } else if (message.command === 'selectTransition') {
                        try {
                            const currentFile = panel.hierarchyStack[panel.hierarchyStack.length - 1].filePath;
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(currentFile));
                            const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                            
                            const text = doc.getText();
                            const { from, to, cond } = message;
                            
                            // Find the 'when <fromState>' block first
                            const fromPattern = new RegExp(`\\bwhen\\s+${from}\\b`, 'i');
                            const fromMatch = fromPattern.exec(text);
                            if (fromMatch) {
                                // Search for state_next <= to or the condition within 400 characters after the when statement
                                const subText = text.substring(fromMatch.index);
                                const toPattern = new RegExp(`state_next\\s*<=\\s*${to}\\b|\\b${to}\\b`, 'i');
                                const toMatch = toPattern.exec(subText);
                                
                                let targetIndex = fromMatch.index;
                                if (toMatch) {
                                    targetIndex += toMatch.index;
                                }
                                
                                const pos = doc.positionAt(targetIndex);
                                ed.selection = new vscode.Selection(pos, pos);
                                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                            } else {
                                // Fallback: search for the destination state name
                                const fallbackPattern = new RegExp(`\\b${to}\\b`, 'i');
                                const fallbackMatch = fallbackPattern.exec(text);
                                if (fallbackMatch) {
                                    const pos = doc.positionAt(fallbackMatch.index);
                                    ed.selection = new vscode.Selection(pos, pos);
                                    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                                }
                            }
                        } catch (err) {
                            console.error("Failed to select transition in editor:", err);
                        }
                    } else if (message.command === 'clickBlock') {
                        const compName = message.componentName;
                        if (!compName) return;

                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        const currentFile = panel.hierarchyStack[panel.hierarchyStack.length - 1].filePath;
                        const projectDir = (workspaceFolders && workspaceFolders.length > 0)
                            ? workspaceFolders[0].uri.fsPath
                            : path.dirname(currentFile);
                        
                        let targetFile = null;
                        let targetEntity = null;
                        try {
                            const project = projectModule.VhdlProject.discover(projectDir);
                            let cleanCompName = compName.trim();
                            if (cleanCompName.startsWith('\\')) {
                                cleanCompName = cleanCompName.substring(1);
                            }
                            
                            const entities = project.find_entities();
                            const isMatch = (nameInProject, cleanComp) => {
                                const projLower = nameInProject.toLowerCase();
                                const compLower = cleanComp.toLowerCase();
                                if (projLower === compLower) return true;
                                if (compLower.startsWith(projLower + "_b")) return true;
                                const bIdx = compLower.lastIndexOf('_b');
                                if (bIdx !== -1 && compLower.substring(0, bIdx) === projLower) return true;
                                return false;
                            };

                            let entityMatch = entities.find(e => isMatch(e[0], cleanCompName));
                            if (entityMatch) {
                                targetEntity = entityMatch[0];
                                targetFile = entityMatch[1];
                            } else {
                                const allFiles = projectModule.findVhdlFiles(projectDir);
                                for (const f of allFiles) {
                                    try {
                                        const text = fs.readFileSync(f, 'utf8');
                                        const cleanText = projectModule.stripComments(text);
                                        const fileEntities = projectModule.getMatches(projectModule.ENTITY_DECL, cleanText);
                                        const foundEnt = fileEntities.find(name => isMatch(name, cleanCompName));
                                        if (foundEnt) {
                                            targetEntity = foundEnt;
                                            targetFile = f;
                                            break;
                                        }
                                    } catch (err) {
                                        console.error(`Error reading ${f}:`, err);
                                    }
                                }
                            }

                            if (!targetFile) {
                                for (const f of project.files) {
                                    try {
                                        const text = fs.readFileSync(f, 'utf8');
                                        const cleanText = projectModule.stripComments(text);
                                        const components = projectModule.getMatches(projectModule.COMPONENT_REF, cleanText);
                                        const foundComp = components.find(name => isMatch(name, cleanCompName));
                                        if (foundComp) {
                                            const sameNameEntity = entities.find(e => e[0].toLowerCase() === foundComp.toLowerCase());
                                            if (sameNameEntity) {
                                                targetEntity = sameNameEntity[0];
                                                targetFile = sameNameEntity[1];
                                            } else {
                                                targetEntity = foundComp;
                                                targetFile = f;
                                            }
                                            break;
                                        }
                                    } catch (err) {
                                        console.error(`Error reading component from ${f}:`, err);
                                    }
                                }
                            }

                            if (!targetFile) {
                                const allFiles = projectModule.findVhdlFiles(projectDir);
                                for (const f of allFiles) {
                                    try {
                                        const text = fs.readFileSync(f, 'utf8');
                                        const cleanText = projectModule.stripComments(text);
                                        const components = projectModule.getMatches(projectModule.COMPONENT_REF, cleanText);
                                        const foundComp = components.find(name => isMatch(name, cleanCompName));
                                        if (foundComp) {
                                            const sameNameEntity = entities.find(e => e[0].toLowerCase() === foundComp.toLowerCase());
                                            if (sameNameEntity) {
                                                targetEntity = sameNameEntity[0];
                                                targetFile = sameNameEntity[1];
                                            } else {
                                                targetEntity = foundComp;
                                                targetFile = f;
                                            }
                                            break;
                                        }
                                    } catch (err) {
                                        console.error(`Error reading component from ${f}:`, err);
                                    }
                                }
                            }

                            if (!targetFile) {
                                let baseSearchName = cleanCompName;
                                const bIdx = cleanCompName.toLowerCase().lastIndexOf('_b');
                                if (bIdx !== -1) {
                                    baseSearchName = cleanCompName.substring(0, bIdx);
                                }

                                const allFiles = projectModule.findVhdlFiles(projectDir);
                                const matchByName = allFiles.find(f => {
                                    const baseName = path.basename(f, path.extname(f)).toLowerCase();
                                    return baseName === baseSearchName.toLowerCase() || baseName === cleanCompName.toLowerCase();
                                });
                                if (matchByName) {
                                    targetFile = matchByName;
                                    targetEntity = baseSearchName;
                                    try {
                                        const text = fs.readFileSync(targetFile, 'utf8');
                                        const cleanText = projectModule.stripComments(text);
                                        const entityMatch = /\bentity\s+(\w+)\s+is\b/i.exec(cleanText);
                                        if (entityMatch) {
                                            targetEntity = entityMatch[1];
                                        }
                                    } catch (e) {}
                                }
                            }
                        } catch (e) {
                            console.error("Failed to find entity file", e);
                        }

                        if (targetFile && targetEntity) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(targetFile);
                                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                            } catch (e) {
                                console.error("Failed to open target VHDL file", e);
                            }
                        } else {
                            vscode.window.showWarningMessage(l('rtl.err.entity_not_found', compName));
                        }
                    } else if (message.command === 'descendHierarchy') {
                        const compName = message.componentName;
                        if (!compName) return;

                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        const currentFile = panel.hierarchyStack[panel.hierarchyStack.length - 1].filePath;
                        const projectDir = (workspaceFolders && workspaceFolders.length > 0)
                            ? workspaceFolders[0].uri.fsPath
                            : path.dirname(currentFile);
                        
                        let targetFile = null;
                        let targetEntity = null;
                        try {
                            const project = projectModule.VhdlProject.discover(projectDir);
                            let cleanCompName = compName.trim();
                            if (cleanCompName.startsWith('\\')) {
                                cleanCompName = cleanCompName.substring(1);
                            }
                            
                            const entities = project.find_entities();
                            const isMatch = (nameInProject, cleanComp) => {
                                const projLower = nameInProject.toLowerCase();
                                const compLower = cleanComp.toLowerCase();
                                if (projLower === compLower) return true;
                                if (compLower.startsWith(projLower + "_b")) return true;
                                const bIdx = compLower.lastIndexOf('_b');
                                if (bIdx !== -1 && compLower.substring(0, bIdx) === projLower) return true;
                                return false;
                            };

                            let entityMatch = entities.find(e => isMatch(e[0], cleanCompName));
                            if (entityMatch) {
                                targetEntity = entityMatch[0];
                                targetFile = entityMatch[1];
                            } else {
                                const allFiles = projectModule.findVhdlFiles(projectDir);
                                for (const f of allFiles) {
                                    try {
                                        const text = fs.readFileSync(f, 'utf8');
                                        const cleanText = projectModule.stripComments(text);
                                        const fileEntities = projectModule.getMatches(projectModule.ENTITY_DECL, cleanText);
                                        const foundEnt = fileEntities.find(name => isMatch(name, cleanCompName));
                                        if (foundEnt) {
                                            targetEntity = foundEnt;
                                            targetFile = f;
                                            break;
                                        }
                                    } catch (err) {}
                                }
                            }
                        } catch (e) {
                            console.error("Failed to find entity file for descent", e);
                        }

                        if (targetFile && targetEntity) {
                            // Check if this sub-component is an FSM
                            try {
                                const targetContent = fs.readFileSync(targetFile, 'utf8');
                                const subExtractor = new rtlExtractorModule.RtlExtractor(targetContent);
                                const fsms = subExtractor.extractFsms();
                                if (fsms && fsms.length > 0) {
                                    vscode.commands.executeCommand('questassure.openFsmDesigner', vscode.Uri.file(targetFile));
                                    return;
                                }
                            } catch (err) {
                                console.error("Failed to check if target file is FSM:", err);
                            }

                            panel.hierarchyStack.push({ entityName: targetEntity, filePath: targetFile });
                            
                            vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: l('rtl.progress.extracting', path.basename(targetFile)),
                                cancellable: false
                            }, async (progress) => {
                                try {
                                    const { ghdlPath } = getGhdlConfig();
                                    const project = projectModule.VhdlProject.discover(projectDir);
                                    project.add_file(targetFile);
                                    
                                    const rtlRes = await ghdlModule.generateRtlSvg(ghdlPath, project, targetFile, targetEntity);
                                    const newSvg = addWhiteBackgroundToSvg(rtlRes.svg);
                                    const newNetlist = rtlRes.netlist;
                                    
                                    const newBitToNetName = {};
                                    if (newNetlist && newNetlist.modules) {
                                        const moduleNames = Object.keys(newNetlist.modules);
                                        if (moduleNames.length > 0) {
                                            const mod = newNetlist.modules[moduleNames[0]];
                                            for (const netName in mod.netnames) {
                                                let cleanName = netName;
                                                if (cleanName.startsWith('\\')) cleanName = cleanName.substring(1);
                                                if (cleanName.startsWith('$')) continue;
                                                const net = mod.netnames[netName];
                                                for (const bit of net.bits) {
                                                    if (typeof bit === 'number') {
                                                        newBitToNetName[bit] = cleanName;
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    svgContent = newSvg;
                                    netlistObj = newNetlist;
                                    bitToNetName = newBitToNetName;
                                    
                                    panel.webview.postMessage({
                                        command: 'loadSvg',
                                        svg: newSvg,
                                        mermaid: "",
                                        netlist: newNetlist,
                                        bitToNetName: newBitToNetName,
                                        hierarchyStack: panel.hierarchyStack
                                    });
                                } catch (err) {
                                    vscode.window.showErrorMessage(l('rtl.err.failed', err.message));
                                    panel.hierarchyStack.pop();
                                }
                            });
                        } else {
                            vscode.window.showWarningMessage(l('rtl.err.entity_not_found', compName));
                        }
                    } else if (message.command === 'jumpToHierarchy') {
                        const idx = message.index;
                        if (idx >= 0 && idx < panel.hierarchyStack.length - 1) {
                            panel.hierarchyStack = panel.hierarchyStack.slice(0, idx + 1);
                            const target = panel.hierarchyStack[idx];
                            
                            vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: l('rtl.progress.extracting', path.basename(target.filePath)),
                                cancellable: false
                            }, async (progress) => {
                                try {
                                    const { ghdlPath } = getGhdlConfig();
                                    const workspaceFolders = vscode.workspace.workspaceFolders;
                                    const projectDir = (workspaceFolders && workspaceFolders.length > 0)
                                        ? workspaceFolders[0].uri.fsPath
                                        : path.dirname(target.filePath);
                                    const project = projectModule.VhdlProject.discover(projectDir);
                                    project.add_file(target.filePath);
                                    
                                    const rtlRes = await ghdlModule.generateRtlSvg(ghdlPath, project, target.filePath, target.entityName);
                                    const newSvg = addWhiteBackgroundToSvg(rtlRes.svg);
                                    const newNetlist = rtlRes.netlist;
                                    
                                    const newBitToNetName = {};
                                    if (newNetlist && newNetlist.modules) {
                                        const moduleNames = Object.keys(newNetlist.modules);
                                        if (moduleNames.length > 0) {
                                            const mod = newNetlist.modules[moduleNames[0]];
                                            for (const netName in mod.netnames) {
                                                let cleanName = netName;
                                                if (cleanName.startsWith('\\')) cleanName = cleanName.substring(1);
                                                if (cleanName.startsWith('$')) continue;
                                                const net = mod.netnames[netName];
                                                for (const bit of net.bits) {
                                                    if (typeof bit === 'number') {
                                                        newBitToNetName[bit] = cleanName;
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    svgContent = newSvg;
                                    netlistObj = newNetlist;
                                    bitToNetName = newBitToNetName;
                                    
                                    panel.webview.postMessage({
                                        command: 'loadSvg',
                                        svg: newSvg,
                                        mermaid: "",
                                        netlist: newNetlist,
                                        bitToNetName: newBitToNetName,
                                        hierarchyStack: panel.hierarchyStack
                                    });
                                } catch (err) {
                                    vscode.window.showErrorMessage(l('rtl.err.failed', err.message));
                                }
                            });
                        }
                    }
                });
            } catch (e) {
                vscode.window.showErrorMessage(l('rtl.err.failed', e.message));
            }
        });
    });
    context.subscriptions.push(showRTLCommand);
}

/**
 * Point de sortie : Appelé lors de la désactivation de l'extension.
 * Nettoie la collection de diagnostics.
 */
function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }
}

module.exports = {
    activate,
    deactivate
};
