/**
 * @file lsp_providers.js
 * @brief Fournisseurs de services de langage (LSP) pour le VHDL dans VS Code.
 * Propose la navigation vers la définition, la recherche de références,
 * l'autocomplétion intelligente (Port/Generic Map) et l'arborescence des symboles (Outline).
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const projectModule = require('./project');

/**
 * Remplace le contenu des commentaires VHDL (mono-ligne et multi-lignes) par des espaces de longueur identique.
 * Cela permet de réaliser des recherches par regex sans modifier la position et les offsets des caractères.
 *
 * @param {string} text - Le code source brut.
 * @returns {string} Le code source nettoyé mais conservant les mêmes positions de caractères.
 */
function cleanCode(text) {
    return text.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
               .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

/**
 * Fournit la fonctionnalité de saut vers la définition (Go to Definition) pour les symboles VHDL.
 * @implements {vscode.DefinitionProvider}
 */
class VhdlDefinitionProvider {
    /**
     * Résout la localisation de la définition du symbole sous le curseur.
     *
     * @param {vscode.TextDocument} document - Document actif.
     * @param {vscode.Position} position - Position du curseur.
     * @param {vscode.CancellationToken} token - Jeton d'annulation.
     * @returns {Promise<vscode.Location|null>} Emplacement de la définition ou null.
     */
    async provideDefinition(document, position, token) {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;
        
        const word = document.getText(wordRange).toLowerCase();
        const text = document.getText();
        const cleanedText = cleanCode(text);

        // 1. Recherche dans les déclarations locales (signaux, variables, constantes, types, sous-types, composants)
        const localPatterns = [
            new RegExp(`\\bsignal\\s+([a-zA-Z0-9_,\\s]+):`, 'i'),
            new RegExp(`\\bvariable\\s+([a-zA-Z0-9_,\\s]+):`, 'i'),
            new RegExp(`\\bconstant\\s+([a-zA-Z0-9_,\\s]+):`, 'i'),
            new RegExp(`\\btype\\s+(${word})\\b`, 'i'),
            new RegExp(`\\bsubtype\\s+(${word})\\b`, 'i'),
            new RegExp(`\\bcomponent\\s+(${word})\\b`, 'i')
        ];

        for (const pattern of localPatterns) {
            let match;
            const regex = new RegExp(pattern.source, 'gi');
            while ((match = regex.exec(cleanedText)) !== null) {
                // Si le premier groupe de capture contient le nom du symbole
                const declaredNames = match[1].split(',').map(n => n.trim().toLowerCase());
                if (declaredNames.includes(word)) {
                    const index = match.index + match[0].toLowerCase().indexOf(word);
                    return new vscode.Location(document.uri, document.positionAt(index));
                }
            }
        }

        // 2. Recherche dans les déclarations de Ports et Generics de l'entité locale
        const portGenericPattern = /\b(port|generic)\s*\(([\s\S]*?)\)\s*;/gi;
        let pgm;
        while ((pgm = portGenericPattern.exec(cleanedText)) !== null) {
            const body = pgm[2];
            const bodyStartIdx = pgm.index + pgm[0].indexOf(body);
            const lines = body.split(';');
            let currentOffset = 0;
            for (const line of lines) {
                if (line.includes(':')) {
                    const leftPart = line.split(':')[0];
                    const names = leftPart.split(',').map(n => n.trim().toLowerCase());
                    if (names.includes(word)) {
                        const lineIdx = leftPart.toLowerCase().indexOf(word);
                        const finalIdx = bodyStartIdx + currentOffset + lineIdx;
                        return new vscode.Location(document.uri, document.positionAt(finalIdx));
                    }
                }
                currentOffset += line.length + 1; // +1 pour le point-virgule séparateur
            }
        }

        // 3. Recherche globale dans les fichiers VHDL du projet (Entités, Packages, Configurations externes)
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const rootPath = folder.uri.fsPath;
                try {
                    const project = projectModule.VhdlProject.discover(rootPath);
                    const allFiles = project.files;
                    
                    for (const filePath of allFiles) {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const cleanedContent = cleanCode(content);
                        
                        const globalPatterns = [
                            new RegExp(`\\bentity\\s+(${word})\\b\\s+is`, 'i'),
                            new RegExp(`\\bpackage\\s+(${word})\\b\\s+is`, 'i'),
                            new RegExp(`\\bcomponent\\s+(${word})\\b`, 'i'),
                            new RegExp(`\\bconfiguration\\s+(${word})\\b`, 'i')
                        ];

                        for (const pat of globalPatterns) {
                            const match = pat.exec(cleanedContent);
                            if (match) {
                                const index = match.index + match[0].toLowerCase().indexOf(word);
                                const fileUri = vscode.Uri.file(filePath);
                                // Charger le document pour convertir l'index en position ligne/colonne
                                const tempDoc = await vscode.workspace.openTextDocument(fileUri);
                                return new vscode.Location(fileUri, tempDoc.positionAt(index));
                            }
                        }
                    }
                } catch (e) {
                    console.error("Workspace definition search failed:", e);
                }
            }
        }

        return null;
    }
}

/**
 * Fournit la fonctionnalité de recherche de toutes les références (Find References) d'un symbole VHDL.
 * @implements {vscode.ReferenceProvider}
 */
class VhdlReferenceProvider {
    /**
     * Recherche toutes les occurrences du mot sous le curseur dans l'espace de travail.
     *
     * @param {vscode.TextDocument} document - Document actif.
     * @param {vscode.Position} position - Position du curseur.
     * @param {vscode.ReferenceContext} context - Contexte de recherche.
     * @param {vscode.CancellationToken} token - Jeton d'annulation.
     * @returns {Promise<vscode.Location[]|null>} Liste des emplacements des références.
     */
    async provideReferences(document, position, context, token) {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;
        
        const word = document.getText(wordRange).toLowerCase();
        const locations = [];

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            try {
                const project = projectModule.VhdlProject.discover(rootPath);
                const allFiles = project.files;

                for (const filePath of allFiles) {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const cleanedContent = cleanCode(content);
                    const fileUri = vscode.Uri.file(filePath);

                    let tempDoc = null;
                    const regex = new RegExp(`\\b${word}\\b`, 'gi');
                    let match;

                    while ((match = regex.exec(cleanedContent)) !== null) {
                        if (!tempDoc) {
                            tempDoc = await vscode.workspace.openTextDocument(fileUri);
                        }
                        const loc = new vscode.Location(fileUri, tempDoc.positionAt(match.index));
                        locations.push(loc);
                    }
                }
            } catch (e) {
                console.error("Workspace references search failed:", e);
            }
        }

        return locations;
    }
}

/**
 * Fournit l'autocomplétion des maps de ports (Port Map) et de paramètres génériques (Generic Map).
 * @implements {vscode.CompletionItemProvider}
 */
class VhdlCompletionItemProvider {
    /**
     * Propose des suggestions de snippet d'autocomplétion d'instanciation.
     *
     * @param {vscode.TextDocument} document - Document actif.
     * @param {vscode.Position} position - Position de saisie.
     * @param {vscode.CancellationToken} token - Jeton d'annulation.
     * @param {vscode.CompletionContext} context - Contexte d'autocomplétion.
     * @returns {Promise<vscode.CompletionItem[]>} Liste des complétions proposées.
     */
    async provideCompletionItems(document, position, token, context) {
        const lineText = document.lineAt(position.line).text.substring(0, position.character);
        const cleanedLine = cleanCode(lineText);

        // Vérifie si l'utilisateur est en train de saisir un bloc port map ou generic map
        const portMapMatch = /\bport\s+map\s*\(\s*$/i.test(cleanedLine);
        const genericMapMatch = /\bgeneric\s+map\s*\(\s*$/i.test(cleanedLine);

        if (!portMapMatch && !genericMapMatch) {
            return [];
        }

        // Remonter en arrière pour extraire le nom du composant ou de l'entité instancié
        const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const cleanedTextBefore = cleanCode(textBefore);
        
        // Regex pour capturer le nom de l'entité/composant instancié avant le port/generic map
        const instRegex = /:\s*(?:entity\s+\w+\.)?([a-zA-Z0-9_]+)\b\s*(?:generic\s+map\s*\([\s\S]*?\)\s*)?\s*(?:port|generic)\s+map\s*\(\s*$/i;
        const match = instRegex.exec(cleanedTextBefore);
        if (!match) {
            return [];
        }

        const componentName = match[1].toLowerCase();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        // Recherche de la déclaration du composant pour en extraire les paramètres
        for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            try {
                const project = projectModule.VhdlProject.discover(rootPath);
                for (const filePath of project.files) {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const cleanedContent = cleanCode(content);

                    // Recherche du bloc entity ou component
                    const blockRegex = new RegExp(`\\b(entity|component)\\s+${componentName}\\b[\\s\\S]*?\\bend\\s+(?:entity|component)\\b`, 'i');
                    const blockMatch = blockRegex.exec(cleanedContent);
                    if (blockMatch) {
                        const blockText = blockMatch[0];
                        const targetKeyword = portMapMatch ? 'port' : 'generic';
                        const paramRegex = new RegExp(`\\b${targetKeyword}\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i');
                        const paramMatch = paramRegex.exec(blockText);
                        
                        if (paramMatch) {
                            const paramsText = paramMatch[1];
                            const lines = paramsText.split(';');
                            const itemsList = [];
                            
                            for (const line of lines) {
                                if (line.includes(':')) {
                                    const leftPart = line.split(':')[0];
                                    const names = leftPart.split(',').map(n => n.trim());
                                    itemsList.push(...names);
                                }
                            }

                            if (itemsList.length > 0) {
                                // Création d'un élément de complétion sous forme de Snippet VS Code
                                const completion = new vscode.CompletionItem(
                                    portMapMatch ? "Auto-complete Ports Map" : "Auto-complete Generics Map",
                                    vscode.CompletionItemKind.Snippet
                                );
                                
                                const snippetLines = itemsList.map((param, idx) => {
                                    return `    ${param} => \${${idx + 1}:${param}}`;
                                });
                                
                                completion.insertText = new vscode.SnippetString(
                                    "\n" + snippetLines.join(",\n") + "\n);"
                                );
                                completion.documentation = new vscode.MarkdownString(`Questassure : Remplissage automatique de l'instanciation de **${componentName}**.`);
                                return [completion];
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Autocomplete ports search failed:", e);
            }
        }

        return [];
    }
}

/**
 * Fournit la liste des symboles du document pour alimenter la vue Plan (Outline) et la navigation.
 * @implements {vscode.DocumentSymbolProvider}
 */
class VhdlDocumentSymbolProvider {
    /**
     * Analyse le document VHDL pour en extraire sa structure hiérarchique.
     *
     * @param {vscode.TextDocument} document - Le document actif.
     * @param {vscode.CancellationToken} token - Jeton d'annulation.
     * @returns {vscode.DocumentSymbol[]} Arborescence des symboles trouvés.
     */
    provideDocumentSymbols(document, token) {
        const symbols = [];
        const text = document.getText();
        const cleanedText = cleanCode(text);

        // 1. Détection des Entités
        const entityRegex = /\bentity\s+(\w+)\s+is\b/gi;
        let match;
        while ((match = entityRegex.exec(cleanedText)) !== null) {
            const name = match[1];
            const pos = document.positionAt(match.index);
            const sym = new vscode.DocumentSymbol(
                name,
                "Entity",
                vscode.SymbolKind.Class,
                new vscode.Range(pos, pos),
                new vscode.Range(pos, pos)
            );
            symbols.push(sym);
        }

        // 2. Détection des Architectures
        const archRegex = /\barchitecture\s+(\w+)\s+of\s+(\w+)\s+is\b/gi;
        while ((match = archRegex.exec(cleanedText)) !== null) {
            const archName = match[1];
            const entityName = match[2];
            const pos = document.positionAt(match.index);
            const sym = new vscode.DocumentSymbol(
                `${archName} (of ${entityName})`,
                "Architecture",
                vscode.SymbolKind.Namespace,
                new vscode.Range(pos, pos),
                new vscode.Range(pos, pos)
            );
            symbols.push(sym);
        }

        // 3. Détection des Packages
        const pkgRegex = /\bpackage\s+(\w+)\s+is\b/gi;
        while ((match = pkgRegex.exec(cleanedText)) !== null) {
            const pkgName = match[1];
            const pos = document.positionAt(match.index);
            const sym = new vscode.DocumentSymbol(
                pkgName,
                "Package",
                vscode.SymbolKind.Package,
                new vscode.Range(pos, pos),
                new vscode.Range(pos, pos)
            );
            symbols.push(sym);
        }

        // 4. Détection locale des Signaux, Variables et Constantes
        const declRegex = /\b(signal|variable|constant)\s+([a-zA-Z0-9_,\s]+)\s*:/gi;
        while ((match = declRegex.exec(cleanedText)) !== null) {
            const kindStr = match[1].toLowerCase();
            const names = match[2].split(',').map(n => n.trim());
            const pos = document.positionAt(match.index);
            const kind = kindStr === 'constant' ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable;
            
            names.forEach(name => {
                const sym = new vscode.DocumentSymbol(
                    name,
                    kindStr,
                    kind,
                    new vscode.Range(pos, pos),
                    new vscode.Range(pos, pos)
                );
                symbols.push(sym);
            });
        }

        // 5. Détection des types énumérés de la Machine à États (FSM State Types)
        const typeRegex = /\btype\s+(\w+)\s+is\s*\(([\s\S]*?)\)\s*;/gi;
        while ((match = typeRegex.exec(cleanedText)) !== null) {
            const typeName = match[1];
            const states = match[2].split(',').map(s => s.trim());
            const pos = document.positionAt(match.index);
            
            const sym = new vscode.DocumentSymbol(
                typeName,
                "FSM State Type",
                vscode.SymbolKind.Enum,
                new vscode.Range(pos, pos),
                new vscode.Range(pos, pos)
            );
            
            states.forEach(state => {
                const childSym = new vscode.DocumentSymbol(
                    state,
                    "State",
                    vscode.SymbolKind.EnumMember,
                    new vscode.Range(pos, pos),
                    new vscode.Range(pos, pos)
                );
                sym.children.push(childSym);
            });

            symbols.push(sym);
        }

        // 6. Détection des processus (Process) combinatoires et séquentiels
        const procRegex = /(?:(\w+)\s*:\s*)?\bprocess\b/gi;
        while ((match = procRegex.exec(cleanedText)) !== null) {
            const label = match[1] || "process";
            const pos = document.positionAt(match.index);
            const sym = new vscode.DocumentSymbol(
                label,
                "Process",
                vscode.SymbolKind.Function,
                new vscode.Range(pos, pos),
                new vscode.Range(pos, pos)
            );
            symbols.push(sym);
        }

        return symbols;
    }
}

/**
 * Enregistre tous les fournisseurs de services LSP VHDL dans le contexte de l'extension.
 *
 * @param {vscode.ExtensionContext} context - Le contexte de l'extension.
 */
function registerLspProviders(context) {
    const selector = { language: 'vhdl', scheme: 'file' };

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new VhdlDefinitionProvider()),
        vscode.languages.registerReferenceProvider(selector, new VhdlReferenceProvider()),
        vscode.languages.registerCompletionItemProvider(selector, new VhdlCompletionItemProvider(), '(', ','),
        vscode.languages.registerDocumentSymbolProvider(selector, new VhdlDocumentSymbolProvider())
    );
}

module.exports = {
    registerLspProviders
};
