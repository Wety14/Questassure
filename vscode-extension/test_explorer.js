/**
 * @file test_explorer.js
 * @brief Gestionnaire de l'explorateur de tests VHDL (Test Explorer) pour VS Code.
 * Découvre les bancs d'essai dans le projet et permet de les exécuter via GHDL.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const projectModule = require('./project');
const ghdlModule = require('./ghdl');
const { l } = require('./l10n');

/**
 * Explorateur de tests natif VS Code pour le projet Questassure VHDL.
 */
class QuestassureTestExplorer {
    /**
     * @param {vscode.ExtensionContext} context - Contexte de l'extension.
     * @param {vscode.OutputChannel} outputChannel - Canal de sortie pour l'affichage des logs de simulation.
     */
    constructor(context, outputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        // Création du contrôleur de tests VS Code
        this.controller = vscode.tests.createTestController('questassureTests', 'Questassure VHDL Tests');
        context.subscriptions.push(this.controller);

        // Définir le gestionnaire de rafraîchissement manuel de l'interface
        this.controller.refreshHandler = async () => {
            this.discover();
        };

        // Enregistrer le profil d'exécution pour les bancs d'essai
        this.runProfile = this.controller.createRunProfile(
            'Run VHDL Testbench',
            vscode.TestRunProfileKind.Run,
            async (request, token) => {
                await this.runTests(request, token);
            },
            true
        );

        // Lancer la découverte automatique à l'initialisation
        this.discover();

        // Rafraîchir les tests lors de la sauvegarde d'un fichier VHDL
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.languageId === 'vhdl') {
                    this.discover();
                }
            })
        );
    }

    /**
     * Découvre et cartographie les bancs d'essai (testbenches) de l'espace de travail.
     * Parcourt les dossiers de l'espace de travail et crée les nœuds correspondants dans l'arbre des tests.
     */
    discover() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            this.controller.items.replace([]);
            return;
        }

        const discoveredUris = new Set();

        for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            try {
                // Instancier le projet et lister ses testbenches
                const project = projectModule.VhdlProject.discover(rootPath);
                const tbs = project.find_testbenches();

                for (const [tbName, tbFilePath] of tbs) {
                    const fileUri = vscode.Uri.file(tbFilePath);
                    discoveredUris.add(fileUri.toString());

                    // Vérifier si le fichier existe déjà dans l'arborescence des tests, sinon le créer
                    let fileItem = this.controller.items.get(fileUri.toString());
                    if (!fileItem) {
                        fileItem = this.controller.createTestItem(
                            fileUri.toString(),
                            path.basename(tbFilePath),
                            fileUri
                        );
                        this.controller.items.add(fileItem);
                    }

                    // Créer l'item pour l'entité spécifique de testbench dans le fichier
                    const tbId = `${fileUri.toString()}#${tbName}`;
                    let tbItem = fileItem.children.get(tbId);
                    if (!tbItem) {
                        tbItem = this.controller.createTestItem(tbId, tbName, fileUri);
                        
                        // Analyse le fichier pour localiser la ligne de l'entité (permet le double-clic pour aller au code)
                        try {
                            const content = fs.readFileSync(tbFilePath, 'utf8');
                            const entityRegex = new RegExp(`\\bentity\\s+${tbName}\\b`, 'i');
                            const match = entityRegex.exec(content);
                            if (match) {
                                const linesBefore = content.substring(0, match.index).split('\n');
                                const lineNum = linesBefore.length - 1;
                                tbItem.range = new vscode.Range(lineNum, 0, lineNum, match[0].length);
                            }
                        } catch (e) {}

                        fileItem.children.add(tbItem);
                    }
                }
            } catch (e) {
                console.error("Test Explorer discovery failed:", e);
            }
        }

        // Nettoyage : supprimer de l'interface les fichiers qui ne font plus partie du projet ou supprimés
        this.controller.items.forEach(item => {
            if (!discoveredUris.has(item.id)) {
                this.controller.items.delete(item.id);
            }
        });
    }

    /**
     * Exécute les tests sélectionnés via GHDL et met à jour l'interface des résultats.
     *
     * @param {vscode.TestRunRequest} request - Demande d'exécution contenant les tests inclus/exclus.
     * @param {vscode.CancellationToken} token - Jeton d'annulation.
     */
    async runTests(request, token) {
        const run = this.controller.createTestRun(request);
        const queue = [];

        // Construire la liste plate des items de test à exécuter
        if (request.include) {
            request.include.forEach(test => {
                if (test.children && test.children.size > 0) {
                    test.children.forEach(child => queue.push(child));
                } else {
                    queue.push(test);
                }
            });
        } else {
            this.controller.items.forEach(item => {
                item.children.forEach(child => queue.push(child));
            });
        }

        const config = vscode.workspace.getConfiguration('questassure');
        const ghdlPath = config.get('ghdlPath') || 'ghdl';
        const stopTime = config.get('stopTime') || '1us';

        // Exécution séquentielle de chaque test
        for (const test of queue) {
            if (token.isCancellationRequested) {
                run.skipped(test);
                continue;
            }

            run.started(test);
            
            const parts = test.id.split('#');
            const fileUri = vscode.Uri.parse(parts[0]);
            let tbName = parts[1];
            
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const projectDir = (workspaceFolders && workspaceFolders.length > 0)
                ? workspaceFolders[0].uri.fsPath
                : path.dirname(fileUri.fsPath);

            // Résolution alternative du nom de testbench
            if (!tbName) {
                try {
                    const project = projectModule.VhdlProject.discover(projectDir);
                    tbName = project.top_testbench;
                    if (!tbName) {
                        const tbs = project.find_testbenches();
                        if (tbs.length > 0) {
                            tbName = tbs[0][0];
                        }
                    }
                } catch (e) {
                    console.error("Failed to resolve fallback tbName", e);
                }
            }

            if (!tbName) {
                run.appendOutput(`[Questassure] [ERROR] No testbench entity name found for test item: ${test.label || test.id}\r\n`);
                run.failed(test, new vscode.TestMessage("No testbench entity name found."));
                continue;
            }

            run.appendOutput(`\r\n[Questassure] Simulating testbench: ${tbName}\r\n`);
            run.appendOutput(`[Questassure] File: ${fileUri.fsPath}\r\n`);

            try {
                const project = projectModule.VhdlProject.discover(projectDir);
                // Mettre à jour l'association des dépendances du projet vers la bibliothèque work
                project.update_library_for_simulation("work", tbName);
                project.save();

                // Lancer la simulation VHDL sous GHDL
                const simRun = await ghdlModule.runTestbench(ghdlPath, project, tbName, stopTime, "work");
                const result = simRun.result;

                if (result.stdout) {
                    run.appendOutput(result.stdout.replace(/\r?\n/g, '\r\n') + '\r\n');
                }
                if (result.stderr) {
                    run.appendOutput(result.stderr.replace(/\r?\n/g, '\r\n') + '\r\n');
                }

                if (result.ok) {
                    run.passed(test);
                    run.appendOutput(`[Questassure] [SUCCESS] ${tbName} completed successfully.\r\n`);
                    
                    // Ouvrir automatiquement le chronogramme si activé dans les préférences
                    if (simRun.vcdPath && vscode.workspace.getConfiguration('questassure').get('openWavesOnTestExplorerRun', true)) {
                        vscode.commands.executeCommand('questassure.openWaveformInline', simRun.vcdPath, tbName, projectDir);
                    }
                } else {
                    const message = new vscode.TestMessage(result.stderr || `Simulation failed with exit code ${result.returncode}`);
                    run.failed(test, message);
                    run.appendOutput(`[Questassure] [FAILED] ${tbName} failed.\r\n`);
                }
            } catch (e) {
                const message = new vscode.TestMessage(e.message);
                run.failed(test, message);
                run.appendOutput(`[Questassure] [ERROR] ${e.message}\r\n`);
            }
        }

        run.end();
    }
}

/**
 * Initialise l'explorateur de tests Questassure.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 * @param {vscode.OutputChannel} outputChannel - Le canal de sortie des logs de simulation.
 */
function initTestExplorer(context, outputChannel) {
    new QuestassureTestExplorer(context, outputChannel);
}

module.exports = {
    initTestExplorer
};
