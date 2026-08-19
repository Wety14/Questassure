#!/usr/bin/env node
/**
 * @file mcp_server.js
 * @brief Serveur MCP (Model Context Protocol) officiel pour Questassure VHDL.
 * Fournit une interface standardisée JSON-RPC 2.0 sur stdio pour connecter
 * les assistants d'intelligence artificielle (Claude Desktop, Cursor, Antigravity,
 * Windsurf, Codex, etc.) aux moteurs d'analyse, de simulation et de synthèse Questassure.
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');

const ghdlModule = require('./ghdl');
const projectModule = require('./project');
const formatterModule = require('./formatter');
const rtlExtractorModule = require('./rtl_extractor');
const staticAnalyzerModule = require('./static_analyzer');
const codeGeneratorsModule = require('./code_generators');
const vcdParserModule = require('./vcd_parser');

const SERVER_NAME = 'questassure-vhdl-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Définition des outils MCP
 */
const TOOLS = [
    {
        name: 'simulate_testbench',
        description: 'Exécute un banc d\'essai (testbench) VHDL avec GHDL, capture les logs, les assertions levées et génère les formes d\'ondes (VCD).',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: {
                    type: 'string',
                    description: 'Chemin absolu ou relatif vers le dossier racine du projet VHDL.'
                },
                testbench_name: {
                    type: 'string',
                    description: 'Nom de l\'entité du testbench à simuler (ex: tb_counter).'
                },
                testbench_file: {
                    type: 'string',
                    description: 'Chemin vers le fichier source du testbench (optionnel).'
                },
                stop_time: {
                    type: 'string',
                    description: 'Durée maximale de la simulation (ex: 1us, 500ns, 10ms). Défaut: 1us.',
                    default: '1us'
                },
                work_lib: {
                    type: 'string',
                    description: 'Nom de la bibliothèque de travail VHDL. Défaut: work.',
                    default: 'work'
                },
                ghdl_path: {
                    type: 'string',
                    description: 'Chemin personnalisé vers l\'exécutable GHDL (optionnel).'
                }
            },
            required: ['project_path']
        }
    },
    {
        name: 'inspect_waveform',
        description: 'Inspecte un fichier d\'ondes de simulation VCD pour extraire la liste des signaux et les transitions de valeurs sur une plage temporelle donnée.',
        inputSchema: {
            type: 'object',
            properties: {
                vcd_path: {
                    type: 'string',
                    description: 'Chemin absolu ou relatif vers le fichier .vcd généré.'
                },
                signals: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Noms ou sous-chaînes des signaux à inspecter (optionnel, tous par défaut).'
                },
                time_start: {
                    type: 'number',
                    description: 'Instants de début de la fenêtre d\'inspection temporelle (défaut: 0).'
                },
                time_end: {
                    type: 'number',
                    description: 'Instants de fin de la fenêtre d\'inspection temporelle.'
                },
                max_events: {
                    type: 'number',
                    description: 'Nombre maximal de transitions à retourner (défaut: 100).',
                    default: 100
                }
            },
            required: ['vcd_path']
        }
    },
    {
        name: 'run_project_tests',
        description: 'Découvre et exécute automatiquement tous les bancs d\'essai VHDL du projet et renvoie un rapport synthétique (succès/échecs/durées).',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: {
                    type: 'string',
                    description: 'Chemin vers la racine du projet VHDL.'
                },
                stop_time: {
                    type: 'string',
                    description: 'Durée de simulation par testbench. Défaut: 1us.',
                    default: '1us'
                },
                ghdl_path: {
                    type: 'string',
                    description: 'Chemin vers l\'exécutable GHDL.'
                }
            },
            required: ['project_path']
        }
    },
    {
        name: 'check_syntax_and_types',
        description: 'Effectue une analyse syntaxique et sémantique (types, dépendances) avec GHDL pour un fichier VHDL donné.',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: {
                    type: 'string',
                    description: 'Chemin du projet.'
                },
                file_path: {
                    type: 'string',
                    description: 'Chemin du fichier VHDL à vérifier.'
                },
                ghdl_path: {
                    type: 'string',
                    description: 'Chemin vers l\'exécutable GHDL.'
                }
            },
            required: ['project_path', 'file_path']
        }
    },
    {
        name: 'detect_hardware_hazards',
        description: 'Analyseur DRC statique Questassure : détecte les verrous involontaires (inferred latches), les listes de sensibilité incomplètes, les boucles combinatoires et le code mort.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Chemin du fichier VHDL (optionnel si `code` est fourni).'
                },
                code: {
                    type: 'string',
                    description: 'Code source VHDL brut à analyser (optionnel si `file_path` est fourni).'
                }
            }
        }
    },
    {
        name: 'synthesize_and_estimate_resources',
        description: 'Effectue une synthèse logique rapide via Yosys pour estimer les ressources matérielles (DFFs, LUTs, portes logiques) et vérifier la synthétisabilité.',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: {
                    type: 'string',
                    description: 'Chemin du projet VHDL.'
                },
                top_entity: {
                    type: 'string',
                    description: 'Nom de l\'entité de premier niveau (Top-level).'
                },
                file_path: {
                    type: 'string',
                    description: 'Fichier VHDL contenant l\'entité de premier niveau.'
                },
                ghdl_path: {
                    type: 'string',
                    description: 'Chemin vers GHDL.'
                }
            },
            required: ['project_path', 'top_entity', 'file_path']
        }
    },
    {
        name: 'get_project_hierarchy',
        description: 'Analyse et retourne la hiérarchie complète du projet VHDL : fichiers, bibliothèques, dépendances, entités et bancs d\'essai.',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: {
                    type: 'string',
                    description: 'Chemin du dossier racine du projet.'
                }
            },
            required: ['project_path']
        }
    },
    {
        name: 'get_entity_interface',
        description: 'Extrait l\'interface d\'une entité VHDL (nom, ports typés et orientés, generics et documentation).',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Chemin du fichier VHDL (optionnel si `code` est fourni).'
                },
                code: {
                    type: 'string',
                    description: 'Code source VHDL contenant l\'entité.'
                }
            }
        }
    },
    {
        name: 'analyze_fsm',
        description: 'Analyse une machine à états finis (FSM) VHDL : états énumérés, état de reset, matrice de transition et diagramme Mermaid.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Chemin du fichier VHDL (optionnel si `code` est fourni).'
                },
                code: {
                    type: 'string',
                    description: 'Code source VHDL.'
                }
            }
        }
    },
    {
        name: 'generate_testbench',
        description: 'Génère un modèle de banc d\'essai (testbench) complet pour une entité VHDL avec horloge, reset et instanciation du composant.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Chemin du fichier VHDL contenant l\'entité (optionnel si `code` est fourni).'
                },
                code: {
                    type: 'string',
                    description: 'Code source VHDL de l\'entité.'
                },
                clock_period: {
                    type: 'string',
                    description: 'Période du signal d\'horloge (ex: 10 ns, 20 ns). Défaut: 10 ns.',
                    default: '10 ns'
                },
                reset_active_low: {
                    type: 'boolean',
                    description: 'Vrai si le signal de reset est actif à l\'état bas (reset_n). Défaut: false.',
                    default: false
                }
            }
        }
    },
    {
        name: 'format_vhdl',
        description: 'Met en forme et aligne le code VHDL selon les règles d\'indentation et d\'alignement Questassure.',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'Code source VHDL brut à formater.'
                }
            },
            required: ['code']
        }
    }
];

/**
 * Définition des ressources MCP
 */
const RESOURCES = [
    {
        uri: 'vhdl://rules/guidelines',
        name: 'Questassure VHDL Guidelines',
        description: 'Règles de style, conventions de nommage et bonnes pratiques pour la conception VHDL synthétisable.',
        mimeType: 'text/markdown'
    },
    {
        uri: 'vhdl://project/hierarchy',
        name: 'Project Hierarchy',
        description: 'Arborescence des fichiers, bibliothèques et dépendances du projet VHDL actif.',
        mimeType: 'application/json'
    },
    {
        uri: 'vhdl://project/testbenches',
        name: 'Project Testbenches',
        description: 'Liste de tous les bancs d\'essai découverts dans le projet VHDL.',
        mimeType: 'application/json'
    }
];

/**
 * Définition des modèles de Prompts MCP
 */
const PROMPTS = [
    {
        name: 'write-testbench',
        description: 'Génère et structure un banc d\'essai complet pour une entité VHDL donnée avec scénarios nominaux et cas limites.',
        arguments: [
            {
                name: 'entity_code',
                description: 'Code source VHDL de l\'entité à tester.',
                required: true
            },
            {
                name: 'requirements',
                description: 'Spécifications ou scénarios particuliers à tester (optionnel).',
                required: false
            }
        ]
    },
    {
        name: 'debug-simulation',
        description: 'Aide à diagnostiquer et corriger une erreur de simulation ou une assertion levée par GHDL.',
        arguments: [
            {
                name: 'simulation_logs',
                description: 'Logs d\'exécution de la simulation ou messages d\'erreur GHDL.',
                required: true
            },
            {
                name: 'source_code',
                description: 'Code source VHDL du composant ou du banc d\'essai.',
                required: false
            }
        ]
    },
    {
        name: 'design-fsm',
        description: 'Conçoit une machine à états (FSM) VHDL robuste à deux processus à partir d\'une spécification fonctionnelle.',
        arguments: [
            {
                name: 'specification',
                description: 'Description textuelle des états, entrées et transitions attendues.',
                required: true
            }
        ]
    },
    {
        name: 'fix-drc-hazards',
        description: 'Corrige les alertes de verrous involontaires (inferred latches) ou de listes de sensibilité.',
        arguments: [
            {
                name: 'drc_report',
                description: 'Rapport d\'analyse DRC ou liste des alertes générées par detect_hardware_hazards.',
                required: true
            },
            {
                name: 'source_code',
                description: 'Code source VHDL à corriger.',
                required: true
            }
        ]
    }
];

/**
 * Résout le code source soit depuis `code`, soit en lisant `file_path`.
 */
function resolveVhdSource(args) {
    if (args.code) {
        return args.code;
    }
    if (args.file_path) {
        const fullPath = path.resolve(args.file_path);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }
        return fs.readFileSync(fullPath, 'utf8');
    }
    throw new Error('Either `file_path` or `code` must be provided.');
}

/**
 * Exécute un outil demandé par le client MCP.
 */
async function handleCallTool(name, args) {
    switch (name) {
        case 'simulate_testbench': {
            const projectPath = path.resolve(args.project_path);
            const stopTime = args.stop_time || '1us';
            const workLib = args.work_lib || 'work';
            const ghdlPath = args.ghdl_path || 'ghdl';

            let tbName = args.testbench_name;
            let tbFile = args.testbench_file ? path.resolve(args.testbench_file) : null;

            const project = projectModule.VhdlProject.discover(projectPath);

            if (!tbName) {
                const tbs = project.find_testbenches();
                if (tbs.size === 0) {
                    throw new Error('No testbench found in project. Please specify testbench_name.');
                }
                const first = tbs.entries().next().value;
                tbName = first[0];
                tbFile = first[1];
            } else if (!tbFile) {
                const tbs = project.find_testbenches();
                tbFile = tbs.get(tbName) || null;
            }

            const simResult = await ghdlModule.runTestbench(
                projectPath,
                tbName,
                stopTime,
                workLib,
                ghdlPath,
                null, // diagnosticsCallback
                tbFile
            );

            return {
                testbench: tbName,
                stopTime,
                workLib,
                success: simResult.returncode === 0,
                returnCode: simResult.returncode,
                vcdGenerated: !!simResult.wavePath,
                vcdPath: simResult.wavePath || null,
                stdout: simResult.stdout || '',
                stderr: simResult.stderr || '',
                commandLogs: simResult.commandLogs || []
            };
        }

        case 'inspect_waveform': {
            const vcdPath = path.resolve(args.vcd_path);
            const queryRes = vcdParserModule.queryVcdFile(vcdPath, {
                signals: args.signals,
                timeStart: args.time_start,
                timeEnd: args.time_end,
                maxEvents: args.max_events || 100
            });
            return queryRes;
        }

        case 'run_project_tests': {
            const projectPath = path.resolve(args.project_path);
            const stopTime = args.stop_time || '1us';
            const ghdlPath = args.ghdl_path || 'ghdl';

            const project = projectModule.VhdlProject.discover(projectPath);
            const tbs = project.find_testbenches();

            const results = [];
            let passedCount = 0;
            let failedCount = 0;

            for (const [tbName, tbFile] of tbs) {
                const startTime = Date.now();
                try {
                    const simResult = await ghdlModule.runTestbench(
                        projectPath,
                        tbName,
                        stopTime,
                        'work',
                        ghdlPath,
                        null,
                        tbFile
                    );
                    const durationMs = Date.now() - startTime;
                    const passed = simResult.returncode === 0;
                    if (passed) passedCount++;
                    else failedCount++;

                    results.push({
                        testbench: tbName,
                        file: tbFile,
                        passed,
                        durationMs,
                        vcdPath: simResult.wavePath || null,
                        errorSummary: passed ? null : (simResult.stderr || simResult.stdout).substring(0, 500)
                    });
                } catch (err) {
                    failedCount++;
                    results.push({
                        testbench: tbName,
                        file: tbFile,
                        passed: false,
                        durationMs: Date.now() - startTime,
                        errorSummary: err.message
                    });
                }
            }

            return {
                projectPath,
                totalTestbenches: tbs.size,
                passed: passedCount,
                failed: failedCount,
                results
            };
        }

        case 'check_syntax_and_types': {
            const projectPath = path.resolve(args.project_path);
            const filePath = path.resolve(args.file_path);
            const ghdlPath = args.ghdl_path || 'ghdl';

            const diagResult = await ghdlModule.analyzeFileInProject(projectPath, filePath, ghdlPath);
            return {
                file: filePath,
                valid: diagResult.returncode === 0,
                diagnostics: diagResult.diagnostics || [],
                rawStderr: diagResult.stderr || ''
            };
        }

        case 'detect_hardware_hazards': {
            const source = resolveVhdSource(args);
            const drcIssues = staticAnalyzerModule.analyzeVhdlCode(source);
            const deadCodeIssues = staticAnalyzerModule.analyzeDeadCode(source);
            return {
                totalIssues: drcIssues.length + deadCodeIssues.length,
                drcIssues,
                deadCodeIssues
            };
        }

        case 'synthesize_and_estimate_resources': {
            const projectPath = path.resolve(args.project_path);
            const topEntity = args.top_entity;
            const filePath = path.resolve(args.file_path);
            const ghdlPath = args.ghdl_path || 'ghdl';

            const project = projectModule.VhdlProject.discover(projectPath);
            const rtlRes = await ghdlModule.generateRtlSvg(project, topEntity, filePath, ghdlPath);

            // Extraire les statistiques de cellules depuis la netlist
            const cellCounts = {};
            if (rtlRes.netlist && rtlRes.netlist.modules) {
                for (const modName of Object.keys(rtlRes.netlist.modules)) {
                    const mod = rtlRes.netlist.modules[modName];
                    if (mod.cells) {
                        for (const [cellName, cell] of Object.entries(mod.cells)) {
                            const t = cell.type || 'unknown';
                            cellCounts[t] = (cellCounts[t] || 0) + 1;
                        }
                    }
                }
            }

            return {
                topEntity,
                synthesizable: true,
                cellCounts,
                svgLength: rtlRes.svg ? rtlRes.svg.length : 0
            };
        }

        case 'get_project_hierarchy': {
            const projectPath = path.resolve(args.project_path);
            const project = projectModule.VhdlProject.discover(projectPath);
            const testbenches = Array.from(project.find_testbenches().entries()).map(([name, file]) => ({ name, file }));

            return {
                root: project.root,
                filesCount: project.files.length,
                files: project.files,
                fileLibraries: project.file_libraries,
                testbenches
            };
        }

        case 'get_entity_interface': {
            const source = resolveVhdSource(args);
            const parsed = codeGeneratorsModule.parseEntity(source);
            if (!parsed) {
                return { found: false, message: 'No valid VHDL entity found in source.' };
            }
            return {
                found: true,
                entityName: parsed.entityName,
                portsCount: parsed.ports.length,
                ports: parsed.ports
            };
        }

        case 'analyze_fsm': {
            const source = resolveVhdSource(args);
            const extractor = new rtlExtractorModule.RtlExtractor(source);
            const fsms = extractor.extractFsms();
            const mermaidDiagram = extractor.generateMermaid();

            return {
                fsmsCount: fsms.length,
                fsms: fsms.map(f => ({
                    name: f.name,
                    typeName: f.typeName,
                    stateSignal: f.stateSignal,
                    initialState: f.initialState,
                    states: f.states,
                    transitionsCount: f.transitions ? f.transitions.length : 0,
                    transitions: f.transitions || []
                })),
                mermaidDiagram
            };
        }

        case 'generate_testbench': {
            const source = resolveVhdSource(args);
            const parsed = codeGeneratorsModule.parseEntity(source);
            if (!parsed) {
                throw new Error('Could not parse valid VHDL entity from provided source.');
            }
            const tbCode = codeGeneratorsModule.generateTestbenchContent(parsed, {
                clockPeriod: args.clock_period || '10 ns',
                resetActiveLow: !!args.reset_active_low
            });
            return {
                entityName: parsed.entityName,
                testbenchEntity: `tb_${parsed.entityName}`,
                code: tbCode
            };
        }

        case 'format_vhdl': {
            if (typeof args.code !== 'string') {
                throw new Error('`code` parameter is required.');
            }
            const formatted = formatterModule.formatVhdl(args.code);
            return {
                formattedCode: formatted
            };
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

/**
 * Lit une ressource MCP demandée.
 */
function handleReadResource(uri) {
    if (uri === 'vhdl://rules/guidelines') {
        const text = `# Bonnes pratiques VHDL & Conventions Questassure

1. **Nommage et orientation des ports :**
   - Entrées : suffixer ou préfixer clairement (ex: \`clk_i\`, \`rst_i\`, \`data_in\`).
   - Sorties : \`data_o\`, \`ready_out\`.
   - Horloge et reset : \`clk\`, \`rst\` (ou \`rst_n\` pour actif bas).

2. **Machines à États (FSM) :**
   - Utiliser un type énuméré (\`type state_t is (IDLE, READ, WRITE, DONE);\`).
   - Structure à 2 processus recommandée (1 process séquentiel pour \`state_reg\`, 1 process combinatoire pour \`state_next\` et sorties).
   - Toujours assigner une valeur par défaut à \`state_next\` en début de process combinatoire pour éviter les verrous involontaires (*latches*).

3. **Conception synthétisable :**
   - Ne jamais mélanger plusieurs fronts d'horloge dans un même process.
   - Toujours inclure toutes les entrées lues dans la liste de sensibilité des process combinatoires.
   - Utiliser \`numeric_std\` de préférence aux bibliothèques non standard comme \`std_logic_arith\`.

4. **Bancs d'essai (Testbenches) :**
   - Utiliser des assertions claires : \`assert data_o = expected report "Test failed!" severity error;\`.
   - Arrêter proprement la simulation via un flag booléen d'horloge ou \`assert false report "Simulation Finished" severity failure;\`.
`;
        return {
            contents: [
                {
                    uri,
                    mimeType: 'text/markdown',
                    text
                }
            ]
        };
    }

    if (uri === 'vhdl://project/hierarchy') {
        const cwd = process.cwd();
        try {
            const project = projectModule.VhdlProject.discover(cwd);
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            root: project.root,
                            files: project.files,
                            libraries: project.file_libraries
                        }, null, 2)
                    }
                ]
            };
        } catch (e) {
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({ error: e.message, root: cwd })
                    }
                ]
            };
        }
    }

    if (uri === 'vhdl://project/testbenches') {
        const cwd = process.cwd();
        try {
            const project = projectModule.VhdlProject.discover(cwd);
            const tbs = Array.from(project.find_testbenches().entries()).map(([name, file]) => ({ name, file }));
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({ root: project.root, testbenches: tbs }, null, 2)
                    }
                ]
            };
        } catch (e) {
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify({ error: e.message, root: cwd })
                    }
                ]
            };
        }
    }

    throw new Error(`Resource not found: ${uri}`);
}

/**
 * Traite une demande de Prompt MCP.
 */
function handleGetPrompt(name, args) {
    const promptDef = PROMPTS.find(p => p.name === name);
    if (!promptDef) {
        throw new Error(`Unknown prompt: ${name}`);
    }

    switch (name) {
        case 'write-testbench': {
            const entityCode = args?.entity_code || '';
            const reqs = args?.requirements ? `\nSpécifications additionnelles :\n${args.requirements}` : '';
            return {
                description: promptDef.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Rédige un banc d'essai (testbench) VHDL exhaustif et synthétisable pour l'entité suivante :\n\n\`\`\`vhdl\n${entityCode}\n\`\`\`\n${reqs}\n\nAssure-toi d'inclure la génération d'horloge, l'initialisation du reset, des scénarios de test complets avec des assertions (assert ... report ... severity error), et l'arrêt propre de la simulation.`
                        }
                    }
                ]
            };
        }

        case 'debug-simulation': {
            const logs = args?.simulation_logs || '';
            const src = args?.source_code ? `\nCode source concerné :\n\`\`\`vhdl\n${args.source_code}\n\`\`\`` : '';
            return {
                description: promptDef.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Voici les logs d'échec d'une simulation VHDL avec GHDL :\n\n\`\`\`\n${logs}\n\`\`\`\n${src}\n\nAnalyse la cause de l'erreur ou de l'assertion levée et propose la correction appropriée.`
                        }
                    }
                ]
            };
        }

        case 'design-fsm': {
            const spec = args?.specification || '';
            return {
                description: promptDef.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Conçois une Machine à États Finis (FSM) en VHDL selon la spécification suivante :\n\n${spec}\n\nUtilise une architecture propre à deux processus (process séquentiel synchrone + process combinatoire pour le calcul de l'état suivant et des sorties), avec un type énuméré pour les états et des valeurs par défaut pour éviter tout verrou involontaire.`
                        }
                    }
                ]
            };
        }

        case 'fix-drc-hazards': {
            const report = args?.drc_report || '';
            const src = args?.source_code || '';
            return {
                description: promptDef.description,
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Corrige les avertissements DRC (verrous involontaires / listes de sensibilité incomplètes / code mort) dans le code VHDL suivant :\n\n\`\`\`vhdl\n${src}\n\`\`\`\n\nRapport DRC Questassure :\n\`\`\`\n${report}\n\`\`\`\n\nConserve la logique fonctionnelle exacte tout en rendant le code conforme aux standards de synthèse FPGA/ASIC.`
                        }
                    }
                ]
            };
        }

        default:
            throw new Error(`Unhandled prompt: ${name}`);
    }
}

/**
 * Traitement des requêtes JSON-RPC 2.0
 */
async function processJsonRpcMessage(req) {
    if (!req || typeof req !== 'object') {
        return {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request' }
        };
    }

    const { id, method, params } = req;

    // Notifications (pas de réponse attendue si id est absent)
    if (id === undefined || id === null) {
        if (method === 'notifications/initialized' || method === 'initialized') {
            // Client initialisé avec succès
            return null;
        }
        return null;
    }

    try {
        switch (method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: {
                            tools: {},
                            resources: {},
                            prompts: {}
                        },
                        serverInfo: {
                            name: SERVER_NAME,
                            version: SERVER_VERSION
                        }
                    }
                };

            case 'ping':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {}
                };

            case 'tools/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        tools: TOOLS
                    }
                };

            case 'tools/call': {
                const toolName = params?.name;
                const toolArgs = params?.arguments || {};
                try {
                    const output = await handleCallTool(toolName, toolArgs);
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [
                                {
                                    type: 'text',
                                    text: typeof output === 'string' ? output : JSON.stringify(output, null, 2)
                                }
                            ]
                        }
                    };
                } catch (toolError) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            isError: true,
                            content: [
                                {
                                    type: 'text',
                                    text: `Error executing tool '${toolName}': ${toolError.message}`
                                }
                            ]
                        }
                    };
                }
            }

            case 'resources/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        resources: RESOURCES
                    }
                };

            case 'resources/read': {
                const uri = params?.uri;
                const res = handleReadResource(uri);
                return {
                    jsonrpc: '2.0',
                    id,
                    result: res
                };
            }

            case 'prompts/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        prompts: PROMPTS
                    }
                };

            case 'prompts/get': {
                const pName = params?.name;
                const pArgs = params?.arguments || {};
                const res = handleGetPrompt(pName, pArgs);
                return {
                    jsonrpc: '2.0',
                    id,
                    result: res
                };
            }

            default:
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${method}`
                    }
                };
        }
    } catch (err) {
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32603,
                message: err.message || 'Internal server error'
            }
        };
    }
}

/**
 * Démarrage de la boucle de transport stdio
 */
function startStdioServer() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const parsed = JSON.parse(trimmed);
            const response = await processJsonRpcMessage(parsed);
            if (response) {
                process.stdout.write(JSON.stringify(response) + '\n');
            }
        } catch (err) {
            const errResp = {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: `Parse error: ${err.message}`
                }
            };
            process.stdout.write(JSON.stringify(errResp) + '\n');
        }
    });

    process.stderr.write(`[${SERVER_NAME}] Questassure MCP Server v${SERVER_VERSION} started on stdio.\n`);
}

if (require.main === module) {
    startStdioServer();
}

module.exports = {
    TOOLS,
    RESOURCES,
    PROMPTS,
    handleCallTool,
    handleReadResource,
    handleGetPrompt,
    processJsonRpcMessage,
    startStdioServer
};
