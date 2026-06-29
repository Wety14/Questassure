/**
 * @file code_generators.js
 * @brief Générateurs de squelettes de code et intégration de l'éditeur FSM interactif.
 * Permet de parser les entités VHDL et de générer automatiquement des testbenches,
 * des modèles de FSM, ainsi que des instanciations de composants (Port Map).
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { l } = require('./l10n');

/**
 * Analyseur syntaxique VHDL minimaliste pour extraire le nom de l'entité et la liste des ports.
 * Supprime préalablement tous les commentaires du code utile.
 *
 * @param {string} vhdlContent - Contenu du code source VHDL.
 * @returns {Object|null} Objet contenant { entityName, ports } ou null si aucune entité valide n'est trouvée.
 */
function parseEntity(vhdlContent) {
    // Supprimer les commentaires mono-ligne et multi-lignes
    const cleanContent = vhdlContent.replace(/--.*$/gm, '')
                                     .replace(/\/\*[\s\S]*?\*\//g, '');

    const entityRegex = /\bentity\s+(\w+)\s+is\b/i;
    const entityMatch = entityRegex.exec(cleanContent);
    if (!entityMatch) return null;
    const entityName = entityMatch[1];

    // Extraire le bloc contenant la déclaration des ports (port)
    let ports = [];
    const portStart = cleanContent.toLowerCase().indexOf('port');
    if (portStart !== -1) {
        const openParen = cleanContent.indexOf('(', portStart);
        if (openParen !== -1) {
            let depth = 1;
            let i = openParen + 1;
            // Parcourir pour trouver la parenthèse fermante équilibrée
            while (i < cleanContent.length && depth > 0) {
                if (cleanContent[i] === '(') depth++;
                else if (cleanContent[i] === ')') depth--;
                i++;
            }
            if (depth === 0) {
                const portText = cleanContent.substring(openParen + 1, i - 1);
                const decls = portText.split(';');
                for (const decl of decls) {
                    if (decl.includes(':')) {
                        const parts = decl.split(':');
                        const names = parts[0].split(',').map(n => n.trim());
                        const typeInfo = parts[1].trim();
                        const tokens = typeInfo.split(/\s+/);
                        if (tokens.length >= 2) {
                            const direction = tokens[0].toLowerCase(); // in, out, inout
                            const typeName = tokens.slice(1).join(' ');
                            for (const name of names) {
                                if (name) {
                                    ports.push({ name, direction, typeName });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return { entityName, ports };
}

/**
 * Commande VS Code : Génère un fichier de banc d'essai (testbench) VHDL pour le fichier actif.
 * Détecte les ports d'horloge et de réinitialisation pour pré-générer les stimulations de base.
 */
async function generateTestbenchCommand() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showWarningMessage("Aucun fichier actif ouvert.");
        return;
    }

    const doc = activeEditor.document;
    const content = doc.getText();
    const parsed = parseEntity(content);

    if (!parsed) {
        vscode.window.showErrorMessage("Impossible de trouver une entité VHDL valide dans ce fichier.");
        return;
    }

    const { entityName, ports } = parsed;
    const tbName = `tb_${entityName}`;
    const tbFilePath = path.join(path.dirname(doc.uri.fsPath), `${tbName}.vhdl`);

    // Détection heuristique des signaux d'horloge (clk) et de reset (rst)
    const clkPort = ports.find(p => /clk|clock/i.test(p.name));
    const rstPort = ports.find(p => /rst|reset|rstn|resetn/i.test(p.name));

    const clkName = clkPort ? clkPort.name : 'clk';
    const rstName = rstPort ? rstPort.name : 'reset';

    // Déclarer les signaux locaux correspondants aux ports de l'entité
    const signalsDecl = ports.map(p => {
        return `    signal ${p.name} : ${p.typeName};`;
    }).join('\n');

    const portMapping = ports.map(p => {
        return `            ${p.name} => ${p.name}`;
    }).join(',\n');

    // Générer le processus d'horloge si un port clk est détecté
    let clkProcess = "";
    if (clkPort) {
        clkProcess = `
    -- Clock generation process
    clk_process : process
    begin
        while not sim_ended loop
            ${clkName} <= '0';
            wait for clk_period/2;
            ${clkName} <= '1';
            wait for clk_period/2;
        end loop;
        wait;
    end process;
`;
    }

    let clkConst = clkPort ? `    constant clk_period : time := 10 ns;\n    signal sim_ended : boolean := false;\n` : "";

    const tbTemplate = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${tbName} is
end ${tbName};

architecture behavior of ${tbName} is

    -- Component Declaration for the Unit Under Test (UUT)
    component ${entityName}
        port(
${ports.map(p => `            ${p.name} : ${p.direction} ${p.typeName}`).join(';\n')}
        );
    end component;

    -- Local Signals
${signalsDecl}

    -- Clock period definitions
${clkConst}
begin

    -- Instantiate the Unit Under Test (UUT)
    uut: ${entityName}
        port map (
${portMapping}
        );
${clkProcess}
    -- Stimulus process
    stim_proc: process
    begin
        -- ====================================================================
        -- COMMENTAIRE DU TESTBENCH QUESTASSURE :
        -- Ajoutez vos stimulations de test ci-dessous.
        -- Pour chaque valeur de signal affectée, précisez la durée associée
        -- à l'aide de l'instruction 'wait for <durée>;'.
        -- Exemple :
        --   ${rstName} <= '1';
        --   wait for 20 ns;
        --   ${rstName} <= '0';
        --   wait for 100 ns;
        -- ====================================================================

        -- Initialisation du reset
${rstPort ? `        ${rstName} <= '1';\n        wait for 20 ns;\n        ${rstName} <= '0';\n        wait for 40 ns;\n` : "        wait for 20 ns;\n"}
        -- AJOUTEZ VOS TESTS ICI :
        -- Exemple d'écriture de test avec affectation et durée associée :
        -- signal_name <= '1';
        -- wait for 50 ns; -- Durée associée à cette valeur

        ${clkPort ? "sim_ended <= true;\n        wait;" : "wait;"}
    end process;

end behavior;
`;

    fs.writeFileSync(tbFilePath, tbTemplate, 'utf8');
    
    // Ouvrir le fichier de testbench nouvellement créé dans l'éditeur
    const newDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(tbFilePath));
    await vscode.window.showTextDocument(newDoc);
    vscode.window.showInformationMessage(`Testbench ${tbName}.vhdl généré avec succès !`);
}

/**
 * Commande VS Code : Génère un modèle (template) de machine à états finis (FSM) VHDL.
 * Demande le nom de l'entité et la liste des états à l'aide de boîtes de dialogue.
 */
async function generateFsmTemplateCommand() {
    const fsmName = await vscode.window.showInputBox({
        prompt: "Nom de l'entité de la FSM",
        value: "my_fsm_module",
        placeHolder: "ex: control_fsm"
    });
    if (!fsmName) return;

    const statesInput = await vscode.window.showInputBox({
        prompt: "Liste des états de la FSM (séparés par des virgules)",
        value: "IDLE, READ, WRITE, DONE",
        placeHolder: "ex: IDLE, ACTIVE, ERROR"
    });
    if (!statesInput) return;

    const states = statesInput.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
    if (states.length === 0) {
        vscode.window.showErrorMessage("La FSM doit avoir au moins un état.");
        return;
    }

    const activeFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const fsmFilePath = path.join(activeFolder, `${fsmName}.vhdl`);

    // Squelette de FSM VHDL standard à deux processus (séquentiel et combinatoire)
    const fsmTemplate = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${fsmName} is
    port (
        clk      : in  std_logic;
        reset    : in  std_logic
    );
end ${fsmName};

architecture behavior of ${fsmName} is

    -- FSM State Definitions
    type state_t is (${states.join(', ')});
    signal state_reg, state_next : state_t;

begin

    -- 1. Sequential process (state registers)
    seq_process : process(clk, reset)
    begin
        if reset = '1' then
            state_reg <= ${states[0]};
        elsif rising_edge(clk) then
            state_reg <= state_next;
        end if;
    end process;

    -- 2. Combinational process (next state and output logic)
    comb_process : process(state_reg)
    begin
        -- Default assignments
        state_next <= state_reg;

        case state_reg is
${states.map(state => {
    return `            when ${state} =>
                -- AJOUTEZ VOTRE LOGIQUE DE TRANSITION ICI
                -- Exemple :
                -- if input_signal = '1' then
                --     state_next <= NEXT_STATE;
                -- end if;
                null;
`;
}).join('\n')}
            when others =>
                state_next <= ${states[0]};
        end case;
    end process;

end behavior;
`;

    // Boîte de dialogue pour choisir l'emplacement de sauvegarde
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(fsmFilePath),
        filters: { 'VHDL Files': ['vhd', 'vhdl'] }
    });

    if (uri) {
        fs.writeFileSync(uri.fsPath, fsmTemplate, 'utf8');
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(`FSM ${fsmName} générée avec succès !`);
    }
}

/**
 * Commande VS Code : Instancie un composant VHDL.
 * Tente d'abord de lire une entité depuis le presse-papiers. Si aucune n'est disponible,
 * propose la liste des entités découvertes dans le projet. Insère ensuite le code
 * d'instanciation (avec signaux locaux et Port Map/Generic Map) à la position actuelle du curseur.
 */
async function instantiateComponentCommand() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showWarningMessage("Aucun fichier actif ouvert.");
        return;
    }

    let vhdlContent = "";
    let sourceLabel = "";

    // 1. Try to read from clipboard first
    try {
        const clipboardText = await vscode.env.clipboard.readText();
        if (clipboardText && /\bentity\s+(\w+)\s+is\b/i.test(clipboardText)) {
            vhdlContent = clipboardText;
            sourceLabel = "presse-papiers";
        }
    } catch (e) {
        console.error("Failed to read clipboard:", e);
    }

    // 2. If clipboard is empty or doesn't contain an entity, fallback to project discover
    if (!vhdlContent) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            try {
                const projectModule = require('./project');
                const project = projectModule.VhdlProject.discover(rootPath);
                const entities = project.find_entities();
                if (entities.length === 0) {
                    vscode.window.showErrorMessage("Aucune entité trouvée dans le projet.");
                    return;
                }
                const items = entities.map(e => ({
                    label: e[0],
                    description: path.basename(e[1]),
                    detail: e[1]
                }));
                const selection = await vscode.window.showQuickPick(items, {
                    placeHolder: "Sélectionnez l'entité à instancier"
                });
                if (!selection) return;

                vhdlContent = fs.readFileSync(selection.detail, 'utf8');
                sourceLabel = `fichier ${selection.description}`;
            } catch (err) {
                vscode.window.showErrorMessage("Erreur lors de la découverte du projet : " + err.message);
                return;
            }
        } else {
            vscode.window.showErrorMessage("Veuillez ouvrir un dossier de projet ou copier une entité dans le presse-papiers.");
            return;
        }
    }

    const parsed = parseEntity(vhdlContent);
    if (!parsed) {
        vscode.window.showErrorMessage("Impossible de trouver une entité VHDL valide.");
        return;
    }

    const { entityName, ports } = parsed;
    
    // Parse generics
    const generics = [];
    const cleanContent = vhdlContent.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const genericStart = cleanContent.toLowerCase().indexOf('generic');
    if (genericStart !== -1) {
        const openParen = cleanContent.indexOf('(', genericStart);
        if (openParen !== -1) {
            let depth = 1;
            let i = openParen + 1;
            while (i < cleanContent.length && depth > 0) {
                if (cleanContent[i] === '(') depth++;
                else if (cleanContent[i] === ')') depth--;
                i++;
            }
            if (depth === 0) {
                const genericText = cleanContent.substring(openParen + 1, i - 1);
                const decls = genericText.split(';');
                for (const decl of decls) {
                    if (decl.includes(':')) {
                        const parts = decl.split(':');
                        const names = parts[0].split(',').map(n => n.trim());
                        const typeInfo = parts[1].trim();
                        const eqIdx = typeInfo.indexOf(':=');
                        let typeName = typeInfo;
                        let defaultVal = "";
                        if (eqIdx !== -1) {
                            typeName = typeInfo.substring(0, eqIdx).trim();
                            defaultVal = typeInfo.substring(eqIdx + 2).trim();
                        }
                        for (const name of names) {
                            if (name) {
                                generics.push({ name, typeName, defaultValue: defaultVal });
                            }
                        }
                    }
                }
            }
        }
    }

    // Generate local signal declarations for all ports
    const signalsDecl = ports.map(p => {
        return `    signal s_${p.name} : ${p.typeName};`;
    }).join('\n');

    // Generate component instantiation code
    let genericMapStr = "";
    if (generics.length > 0) {
        genericMapStr = `\n        generic map (\n${generics.map(g => `            ${g.name} => ${g.defaultValue || 'value'}`).join(',\n')}\n        )`;
    }

    const portMapStr = `        port map (\n${ports.map(p => `            ${p.name} => s_${p.name}`).join(',\n')}\n        );`;

    const instantiationCode = `
    -- Local signal declarations for instantiating ${entityName}
${signalsDecl}

    -- Instantiation of ${entityName}
    inst_${entityName} : entity work.${entityName}${genericMapStr}
${portMapStr}
`;

    activeEditor.edit(editBuilder => {
        editBuilder.insert(activeEditor.selection.active, instantiationCode);
    });

    vscode.window.showInformationMessage(`Composant ${entityName} instancié avec succès depuis le ${sourceLabel} !`);
}

/**
 * Formate une valeur brute en une valeur VHDL valide (entoure les caractères simples de quotes
 * et les vecteurs de guillemets doubles si nécessaire).
 *
 * @param {string} val - La valeur textuelle à formater.
 * @returns {string} La valeur formatée pour le VHDL.
 */
function formatVhdlValue(val) {
    const trimmed = val.trim();
    if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith("(") || trimmed.toLowerCase().startsWith("x\"")) {
        return trimmed;
    }
    if (/^[01UXZWLH-]+$/.test(trimmed) && trimmed.length > 1) {
        return `"${trimmed}"`;
    }
    if (trimmed.length === 1) {
        return `'${trimmed}'`;
    }
    return trimmed;
}

/**
 * Génère le code VHDL complet (définition des états et processus séquentiel + combinatoire)
 * représentant une FSM à partir des données graphiques de l'éditeur.
 *
 * @param {string} fsmName - Nom de l'entité FSM.
 * @param {Object[]} states - Liste des états graphiques.
 * @param {Object[]} transitions - Liste des transitions graphiques.
 * @param {Object} defaultOutputs - Sorties par défaut associées à la FSM.
 * @returns {string} Code source VHDL généré pour la FSM.
 */
function generateFsmVhdl(fsmName, states, transitions, defaultOutputs) {
    if (!states || states.length === 0) {
        return `-- [QUESTASSURE FSM START]
    -- Note: Ajoutez des états dans le concepteur graphique de FSM pour générer le code VHDL correspondant.
-- [QUESTASSURE FSM END]`;
    }
    const stateListStr = states.map(s => s.name).join(', ');
    
    // Default outputs assignments
    let defaultAssigns = "";
    if (defaultOutputs) {
        for (const [sig, val] of Object.entries(defaultOutputs)) {
            defaultAssigns += `        ${sig} <= ${formatVhdlValue(val)};\n`;
        }
    }

    // Generate cases for each state
    const cases = states.map(state => {
        const stateTransitions = transitions.filter(t => t.from === state.name);
        let transitionCode = "";
        
        let isFirst = true;
        stateTransitions.forEach(t => {
            const cond = t.cond && t.cond !== 'default' ? t.cond : "";
            if (cond) {
                if (isFirst) {
                    transitionCode += `                if ${cond} then\n                    state_next <= ${t.to};\n`;
                    isFirst = false;
                } else {
                    transitionCode += `                elsif ${cond} then\n                    state_next <= ${t.to};\n`;
                }
            } else {
                if (isFirst) {
                    transitionCode += `                state_next <= ${t.to};\n`;
                } else {
                    transitionCode += `                else\n                    state_next <= ${t.to};\n`;
                }
            }
        });
        if (!isFirst && stateTransitions.some(t => !t.cond || t.cond === 'default')) {
            transitionCode += `                end if;\n`;
        } else if (!isFirst) {
            transitionCode += `                end if;\n`;
        }

        let outputCode = "";
        if (state.outputs) {
            for (const [sig, val] of Object.entries(state.outputs)) {
                outputCode += `                ${sig} <= ${formatVhdlValue(val)};\n`;
            }
        }

        return `            when ${state.name} =>
${outputCode}${transitionCode || '                null;'}`;
    }).join('\n');

    return `-- [QUESTASSURE FSM START]
    -- FSM State Definitions
    type state_t is (${stateListStr});
    signal state_reg, state_next : state_t;

    -- [QUESTASSURE FSM PROCESSES]
    -- 1. Sequential process (state registers)
    seq_process : process(clk, reset)
    begin
        if reset = '1' then
            state_reg <= ${states[0]?.name || 'IDLE'};
        elsif rising_edge(clk) then
            state_reg <= state_next;
        end if;
    end process;

    -- 2. Combinational process (next state and output logic)
    comb_process : process(state_reg)
    begin
        -- Default assignments
        state_next <= state_reg;
${defaultAssigns}
        case state_reg is
${cases}
            when others =>
                state_next <= ${states[0]?.name || 'IDLE'};
        end case;
    end process;
-- [QUESTASSURE FSM END]`;
}

/**
 * Enveloppe le code généré d'une FSM dans un fichier VHDL complet avec bibliothèques,
 * déclaration d'entité et architecture.
 *
 * @param {string} entityName - Nom de l'entité FSM.
 * @param {Object[]} ports - Liste des ports d'E/S de la FSM.
 * @param {string} generatedFsmCode - Code de la FSM généré par `generateFsmVhdl`.
 * @returns {string} Contenu complet du fichier VHDL.
 */
function generateFullFsmFile(entityName, ports, generatedFsmCode) {
    const portDecls = [];
    portDecls.push("        clk      : in  std_logic");
    portDecls.push("        reset    : in  std_logic");
    
    const standardPorts = ['clk', 'clock', 'reset', 'resetn', 'rst', 'rstn'];
    const filteredPorts = (ports || []).filter(p => !standardPorts.includes(p.name.toLowerCase()));
    
    filteredPorts.forEach(p => {
        portDecls.push(`        ${p.name.padEnd(8)} : ${p.direction === 'in' ? 'in ' : 'out'} ${p.typeName}`);
    });
    
    const portsDeclStr = portDecls.join(';\n');

    return `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${entityName} is
    port (
${portsDeclStr}
    );
end entity ${entityName};

architecture behavior of ${entityName} is
begin

${generatedFsmCode}

end architecture behavior;
`;
}

/**
 * Commande VS Code : Ouvre l'éditeur graphique de FSM interactif.
 * Charge le fichier VHDL ciblé, en extrait l'éventuelle FSM existante via `RtlExtractor`
 * et instancie un panneau Webview VS Code contenant l'éditeur graphique.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 * @param {vscode.Uri|string|null} targetUri - URI optionnelle du fichier VHDL cible.
 */
async function openFsmDesignerCommand(context, targetUri = null) {
    let doc;
    if (targetUri) {
        const resolvedUri = typeof targetUri === 'string' ? vscode.Uri.file(targetUri) : targetUri;
        doc = await vscode.workspace.openTextDocument(resolvedUri);
    } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage("Aucun fichier actif ouvert.");
            return;
        }
        doc = activeEditor.document;
    }

    const content = doc.getText();
    const fileBasename = path.basename(doc.fileName, path.extname(doc.fileName)).replace(/[^a-zA-Z0-9_]/g, '_');

    const panel = vscode.window.createWebviewPanel(
        'questassureFsmDesigner',
        `Questassure FSM Designer - ${fileBasename}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)]
        }
    );

    const htmlPath = path.join(context.extensionPath, 'fsm_designer_webview.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    panel.webview.html = html;

    const rtlExtractorModule = require('./rtl_extractor');
    const extractor = new rtlExtractorModule.RtlExtractor(content);
    const fsms = extractor.extractFsms();
    const existingFsm = (fsms && fsms.length > 0) ? fsms[0] : null;
    const defaultOutputs = extractor.extractDefaultOutputs();
    const ports = extractor.extractPorts();

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'ready') {
            panel.webview.postMessage({
                command: 'loadFsm',
                fsm: existingFsm,
                ports: ports,
                defaultOutputs: defaultOutputs,
                entityName: fileBasename
            });
        } else if (message.command === 'selectState') {
            try {
                const activeEd = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
                if (activeEd) {
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
                        activeEd.selection = new vscode.Selection(pos, pos);
                        activeEd.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                }
            } catch (err) {
                console.error("Failed to select state in editor:", err);
            }
        } else if (message.command === 'selectTransition') {
            try {
                const activeEd = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
                if (activeEd) {
                    const text = doc.getText();
                    const { from, to } = message;
                    const whenPattern = new RegExp(`\\bwhen\\s+${from}\\b`, 'i').exec(text);
                    if (whenPattern) {
                        const remainingText = text.substring(whenPattern.index);
                        const nextStatePattern = new RegExp(`state_next\\s*<=\\s*${to}\\b|\\b${to}\\b`, 'i').exec(remainingText);
                        let idx = whenPattern.index;
                        if (nextStatePattern) {
                            idx += nextStatePattern.index;
                        }
                        const pos = doc.positionAt(idx);
                        activeEd.selection = new vscode.Selection(pos, pos);
                        activeEd.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    } else {
                        const fallbackPattern = new RegExp(`\\b${to}\\b`, 'i').exec(text);
                        if (fallbackPattern) {
                            const pos = doc.positionAt(fallbackPattern.index);
                            activeEd.selection = new vscode.Selection(pos, pos);
                            activeEd.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                        }
                    }
                }
            } catch (err) {
                console.error("Failed to select transition in editor:", err);
            }
        } else if (message.command === 'saveFsm') {
            const { fsmName, states, transitions, defaultOutputs, ports } = message;
            const generatedCode = generateFsmVhdl(fsmName, states, transitions, defaultOutputs);

            try {
                const activeEd = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                if (activeEd) {
                    const text = doc.getText();
                    const startMarker = "-- [QUESTASSURE FSM START]";
                    const endMarker = "-- [QUESTASSURE FSM END]";
                    
                    const startIdx = text.indexOf(startMarker);
                    const endIdx = text.indexOf(endMarker);

                    if (startIdx !== -1 && endIdx !== -1) {
                        const range = new vscode.Range(
                            doc.positionAt(startIdx),
                            doc.positionAt(endIdx + endMarker.length)
                        );
                        await activeEd.edit(editBuilder => {
                            editBuilder.replace(range, generatedCode);
                        });
                        vscode.window.showInformationMessage("FSM mise à jour avec succès !");
                    } else {
                        const fullFileContent = generateFullFsmFile(fsmName, ports, generatedCode);
                        const range = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(text.length)
                        );
                        await activeEd.edit(editBuilder => {
                            editBuilder.replace(range, fullFileContent);
                        });
                        vscode.window.showInformationMessage("FSM créée et fichier enregistré avec succès !");
                    }
                }
            } catch (err) {
                vscode.window.showErrorMessage("Erreur lors de la sauvegarde de la FSM : " + err.message);
            }
        } else if (message.command === 'exportSvg') {
            const bgChoice = await vscode.window.showQuickPick([
                { label: "Fond transparent (Transparent background)", value: "transparent" },
                { label: "Fond blanc (White background)", value: "white" },
                { label: "Fond sombre (Dark background)", value: "dark" }
            ], { placeHolder: "Choisissez le type d'arrière-plan pour l'export SVG" });
            
            if (!bgChoice) return;

            let finalSvg = "";
            if (bgChoice.value === 'transparent') {
                finalSvg = message.transparentSvg;
            } else if (bgChoice.value === 'white') {
                finalSvg = message.whiteSvg;
            } else {
                finalSvg = message.darkSvg;
            }

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '', `${fileBasename}_fsm.svg`)),
                filters: { 'SVG Files': ['svg'] }
            });
            if (uri) {
                try {
                    fs.writeFileSync(uri.fsPath, finalSvg, 'utf8');
                    vscode.window.showInformationMessage("SVG exporté avec succès !");
                } catch (e) {
                    vscode.window.showErrorMessage("Échec de l'export du SVG : " + e.message);
                }
            }
        }
    });
}

/**
 * Enregistre toutes les commandes de génération de code et l'éditeur de FSM auprès de VS Code.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 */
function registerCodeGenerators(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('questassure.generateTestbench', generateTestbenchCommand),
        vscode.commands.registerCommand('questassure.generateFsmTemplate', generateFsmTemplateCommand),
        vscode.commands.registerCommand('questassure.instantiateComponent', instantiateComponentCommand),
        vscode.commands.registerCommand('questassure.openFsmDesigner', (targetUri) => openFsmDesignerCommand(context, targetUri))
    );
}

module.exports = {
    registerCodeGenerators
};
