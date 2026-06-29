/**
 * @file static_analyzer.js
 * @brief Analyseur statique (DRC Linter) pour le code source VHDL.
 * Détecte les anomalies de liste de sensibilité, les verrous (latches) involontaires,
 * les boucles combinatoires et les variables/signaux inutilisés (code mort).
 */

const vscode = require('vscode');

/**
 * Mots-clés et types standards VHDL à ignorer lors de l'identification des signaux lus.
 */
const VHDL_KEYWORDS = new Set([
    "abs", "access", "after", "alias", "all", "and", "architecture", "array", "assert", "attribute",
    "begin", "block", "body", "buffer", "bus", "case", "component", "configuration", "constant",
    "disconnect", "downto", "else", "elsif", "end", "entity", "exit", "file", "for", "function",
    "generate", "generic", "group", "guarded", "if", "impure", "in", "inertial", "inout", "is",
    "label", "library", "linkage", "literal", "loop", "map", "mod", "nand", "new", "next", "nor",
    "not", "null", "of", "on", "open", "or", "others", "out", "package", "port", "postponed",
    "procedure", "process", "pure", "range", "record", "register", "reject", "rem", "report",
    "return", "rol", "ror", "select", "severity", "signal", "shared", "sla", "sll", "sra", "srl",
    "subtype", "then", "to", "transport", "type", "unaffected", "units", "until", "use", "variable",
    "wait", "when", "while", "with", "xnor", "xor",
    "boolean", "bit", "bit_vector", "character", "integer", "natural", "positive", "real", "signed",
    "std_logic", "std_logic_vector", "string", "time", "unsigned", "rising_edge", "falling_edge",
    "std_ulogic", "std_ulogic_vector", "work", "ieee", "std", "others"
]);

/**
 * Sépare et supprime le contenu des commentaires VHDL (mono-ligne et blocs).
 * Remplace les commentaires par des espaces afin de conserver les indices d'octets d'origine.
 *
 * @param {string} text - Le code source VHDL brut.
 * @returns {string} Le code source nettoyé de ses commentaires.
 */
function stripComments(text) {
    return text.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
               .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

/**
 * Détermine si un identifiant à un index donné dans le corps d'un processus est l'objet d'une affectation.
 * (c'est-à-dire s'il est suivi des opérateurs `<=` ou `:=`).
 *
 * @param {string} processBody - Le corps textuel du processus.
 * @param {number} idmIndex - Index de début du mot dans la chaîne du processus.
 * @param {number} idmLength - Longueur du mot recherché.
 * @returns {boolean} Vrai s'il s'agit d'une affectation (LHS), Faux sinon.
 */
function isAssignment(processBody, idmIndex, idmLength) {
    const textAfter = processBody.substring(idmIndex + idmLength).trim();
    if (!textAfter.startsWith('<=') && !textAfter.startsWith(':=')) {
        return false;
    }
    const op = textAfter.startsWith('<=') ? '<=' : ':=';
    const afterOp = textAfter.substring(op.length).trim();
    const match = /;|(\bthen\b)|(\bloop\b)|(=>)/i.exec(afterOp);
    if (match) {
        if (match[0] === ';') {
            return true;
        } else {
            return false;
        }
    }
    return true;
}

/**
 * Extrait de façon robuste l'identifiant du signal de base à gauche (LHS) d'un opérateur d'affectation.
 * Gère correctement les parenthèses d'indexation, de tranches (slices), et les sélections de champs d'enregistrements.
 *
 * @param {string} text - Le corps textuel du processus.
 * @param {number} opIndex - Index de l'opérateur d'affectation (<= ou :=).
 * @returns {string|null} L'identifiant du signal de base trouvé, ou null.
 */
function extractLhsIdentifier(text, opIndex) {
    let i = opIndex - 1;
    while (i >= 0 && /\s/.test(text[i])) {
        i--;
    }
    if (i < 0) return null;

    if (text[i] === ')') {
        let depth = 1;
        i--;
        while (i >= 0 && depth > 0) {
            if (text[i] === ')') depth++;
            else if (text[i] === '(') depth--;
            i--;
        }
        while (i >= 0 && /\s/.test(text[i])) {
            i--;
        }
    }
    if (i < 0) return null;

    let word = "";
    while (i >= 0) {
        const char = text[i];
        if (/[a-zA-Z0-9_]/.test(char)) {
            word = char + word;
            i--;
        } else if (char === '.') {
            word = "";
            i--;
            while (i >= 0 && /\s/.test(text[i])) {
                i--;
            }
        } else {
            break;
        }
    }
    
    if (/^[a-zA-Z]/.test(word)) {
        return word;
    }
    return null;
}

/**
 * Construit un arbre syntaxique simplifié (AST) des structures conditionnelles (if, case, assignment)
 * d'un corps de processus pour une analyse précise de verrous (latches).
 *
 * @param {string} text - Le texte brut du corps du processus.
 * @returns {Object} Le nœud racine (de type 'block') de l'AST simplifié.
 */
function parseProcessBody(text) {
    let pos = 0;
    
    function peekWord() {
        let i = pos;
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (i >= text.length) return "";
        let word = "";
        while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) {
            word += text[i];
            i++;
        }
        return word.toLowerCase();
    }
    
    function parseBlock() {
        const statements = [];
        while (pos < text.length) {
            while (pos < text.length && /\s/.test(text[pos])) {
                pos++;
            }
            if (pos >= text.length) break;
            
            const word = peekWord();
            if (word === 'end') {
                let nextWordPos = pos + 3;
                while (nextWordPos < text.length && /\s/.test(text[nextWordPos])) {
                    nextWordPos++;
                }
                let nextWord = "";
                let tempIdx = nextWordPos;
                while (tempIdx < text.length && /[a-zA-Z0-9_]/.test(text[tempIdx])) {
                    nextWord += text[tempIdx];
                    tempIdx++;
                }
                nextWord = nextWord.toLowerCase();
                if (nextWord === 'if' || nextWord === 'case' || nextWord === 'process') {
                    break;
                }
            }
            if (word === 'elsif' || word === 'else' || word === 'when') {
                break;
            }
            
            if (word === 'if') {
                statements.push(parseIf());
            } else if (word === 'case') {
                statements.push(parseCase());
            } else {
                let semicolonIdx = text.indexOf(';', pos);
                if (semicolonIdx === -1) semicolonIdx = text.length;
                
                let opIdx = text.indexOf('<=', pos);
                if (opIdx === -1 || opIdx > semicolonIdx) {
                    opIdx = text.indexOf(':=', pos);
                }
                
                if (opIdx !== -1 && opIdx < semicolonIdx) {
                    const target = extractLhsIdentifier(text, opIdx);
                    if (target) {
                        statements.push({ type: 'assignment', target: target.toLowerCase(), index: pos });
                    }
                    pos = semicolonIdx + 1;
                } else {
                    if (word) {
                        pos += word.length;
                    } else {
                        pos++;
                    }
                }
            }
        }
        return { type: 'block', statements };
    }
    
    function parseIf() {
        const startIdx = pos;
        pos += 2;
        
        const branches = [];
        
        let thenIdx = text.toLowerCase().indexOf('then', pos);
        if (thenIdx === -1) thenIdx = pos;
        pos = thenIdx + 4;
        
        const ifBody = parseBlock();
        branches.push({ type: 'if', body: ifBody });
        
        while (pos < text.length) {
            const nextWord = peekWord();
            if (nextWord === 'elsif') {
                pos += 5;
                let thenIdx = text.toLowerCase().indexOf('then', pos);
                if (thenIdx === -1) thenIdx = pos;
                pos = thenIdx + 4;
                const elsifBody = parseBlock();
                branches.push({ type: 'elsif', body: elsifBody });
            } else if (nextWord === 'else') {
                pos += 4;
                const elseBody = parseBlock();
                branches.push({ type: 'else', body: elseBody });
            } else {
                break;
            }
        }
        
        const endIfIdx = text.toLowerCase().indexOf('end if', pos);
        if (endIfIdx !== -1) {
            pos = endIfIdx + 6;
            let semi = text.indexOf(';', pos);
            if (semi !== -1 && semi < pos + 5) {
                pos = semi + 1;
            }
        }
        
        return { type: 'if', branches, index: startIdx };
    }
    
    function parseCase() {
        const startIdx = pos;
        pos += 4;
        
        let isIdx = text.toLowerCase().indexOf('is', pos);
        if (isIdx === -1) isIdx = pos;
        pos = isIdx + 2;
        
        const branches = [];
        
        while (pos < text.length) {
            const nextWord = peekWord();
            if (nextWord === 'when') {
                pos += 4;
                let arrowIdx = text.indexOf('=>', pos);
                if (arrowIdx === -1) arrowIdx = pos;
                
                const condText = text.substring(pos, arrowIdx).trim().toLowerCase();
                const isOthers = condText === 'others';
                
                pos = arrowIdx + 2;
                const body = parseBlock();
                branches.push({ type: 'when', isOthers, body });
            } else {
                break;
            }
        }
        
        const endCaseIdx = text.toLowerCase().indexOf('end case', pos);
        if (endCaseIdx !== -1) {
            pos = endCaseIdx + 8;
            let semi = text.indexOf(';', pos);
            if (semi !== -1 && semi < pos + 5) {
                pos = semi + 1;
            }
        }
        
        return { type: 'case', branches, index: startIdx };
    }
    
    return parseBlock();
}

/**
 * Parcourt récursivement l'AST simplifié pour déterminer si un signal est affecté
 * dans tous les chemins d'exécution possibles d'un processus.
 *
 * @param {Object} node - Le nœud AST à analyser.
 * @param {string} sig - Le nom du signal en minuscules.
 * @returns {boolean} Vrai si le signal est affecté dans tous les chemins possibles.
 */
function isSignalAssignedInAllPaths(node, sig) {
    if (!node) return false;
    
    if (node.type === 'assignment') {
        return node.target === sig;
    }
    
    if (node.type === 'block') {
        for (const stmt of node.statements) {
            if (isSignalAssignedInAllPaths(stmt, sig)) {
                return true;
            }
        }
        return false;
    }
    
    if (node.type === 'if') {
        const hasElse = node.branches.some(b => b.type === 'else');
        if (!hasElse) return false;
        
        for (const branch of node.branches) {
            if (!isSignalAssignedInAllPaths(branch.body, sig)) {
                return false;
            }
        }
        return true;
    }
    
    if (node.type === 'case') {
        const hasOthers = node.branches.some(b => b.isOthers);
        if (!hasOthers) return false;
        
        for (const branch of node.branches) {
            if (!isSignalAssignedInAllPaths(branch.body, sig)) {
                return false;
            }
        }
        return true;
    }
    
    return false;
}

/**
 * Extrait les ports d'entrée (direction 'in') déclarés dans les entités du fichier.
 *
 * @param {string} documentText - Le code source brut du fichier.
 * @returns {Set<string>} Ensemble des noms de ports d'entrée (en minuscules).
 */
function findInPorts(documentText) {
    const inPorts = new Set();
    const cleanText = stripComments(documentText);
    
    const entityRegex = /\bentity\s+(\w+)\s+is\b[\s\S]*?\bend\s+(?:entity\b)?(?:\s*\1\b)?\s*;/gi;
    let em;
    while ((em = entityRegex.exec(cleanText)) !== null) {
        const entityBody = em[0];
        const portStart = entityBody.toLowerCase().indexOf('port');
        if (portStart !== -1) {
            const openParen = entityBody.indexOf('(', portStart);
            if (openParen !== -1) {
                let depth = 1;
                let i = openParen + 1;
                while (i < entityBody.length && depth > 0) {
                    if (entityBody[i] === '(') depth++;
                    else if (entityBody[i] === ')') depth--;
                    i++;
                }
                if (depth === 0) {
                    const portText = entityBody.substring(openParen + 1, i - 1);
                    const decls = portText.split(';');
                    for (const decl of decls) {
                        if (decl.includes(':')) {
                            const parts = decl.split(':');
                            const names = parts[0].split(',').map(n => n.trim().toLowerCase());
                            const typeInfo = parts[1].trim();
                            const tokens = typeInfo.split(/\s+/);
                            if (tokens.length >= 1) {
                                const direction = tokens[0].toLowerCase();
                                if (direction === 'in') {
                                    names.forEach(name => {
                                        if (name) inPorts.add(name);
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return inPorts;
}

/**
 * Analyse le code VHDL pour détecter les erreurs liées aux processus combinatoires :
 * - Signaux lus mais absents de la liste de sensibilité.
 * - Signaux présents dans la liste de sensibilité mais jamais lus.
 * - Risques de latches involontaires (affectations conditionnelles incomplètes).
 * - Boucles combinatoires directes (un signal est à la fois lu et écrit dans un processus combinatoire).
 *
 * @param {string} documentText - Le code source brut du document.
 * @returns {Object[]} Liste des anomalies détectées contenant l'indice, le message et la sévérité.
 */
function analyzeVhdlCode(documentText) {
    const diagnostics = [];
    const cleanText = stripComments(documentText);
    const inPorts = findInPorts(documentText);

    // Dictionnaire pour collecter les pilotes (drivers) de signaux globaux
    const signalDrivers = new Map(); // nom_signal -> Array of { label, line, index }

    // Regex pour capturer les processus et isoler leurs composants (label, liste de sensibilité, variables, corps)
    const processRegex = /(?:(\w+)\s*:\s*)?\bprocess\b\s*(?:\((.*?)\))?\s*([\s\S]*?)\bbegin\b([\s\S]*?)\bend\s+process\b/gi;
    let match;

    while ((match = processRegex.exec(cleanText)) !== null) {
        const processLabel = match[1] || "process";
        const sensListStr = match[2] || "";
        const varBlock = match[3] || "";
        const processBody = match[4] || "";
        const processStartIndex = match.index;

        const sensList = sensListStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);

        // Détecter si le processus est séquentiel (contient un front d'horloge synchrone)
        const isSequential = /rising_edge|falling_edge|'event/i.test(processBody);

        // Identifier les variables locales du processus pour ne pas les confondre avec des signaux globaux
        const localVariables = new Set();
        const varRegex = /\bvariable\s+([a-zA-Z0-9_,\s]+)\s*:/gi;
        let vm;
        while ((vm = varRegex.exec(varBlock)) !== null) {
            vm[1].split(',').map(v => v.trim().toLowerCase()).forEach(v => localVariables.add(v));
        }

        const readSignals = new Set();
        const assignedSignals = new Set();

        // 1. Extraire toutes les affectations et marquer leurs indices de début (LHS)
        const writeIndices = new Set();
        
        // Trouver tous les <= et := dans le processBody
        let opIdx = processBody.indexOf('<=');
        while (opIdx !== -1) {
            const target = extractLhsIdentifier(processBody, opIdx);
            if (target) {
                const targetLower = target.toLowerCase();
                assignedSignals.add(targetLower);
                const idStartIdx = processBody.lastIndexOf(target, opIdx);
                if (idStartIdx !== -1) {
                    writeIndices.add(idStartIdx);
                }
            }
            opIdx = processBody.indexOf('<=', opIdx + 2);
        }
        
        opIdx = processBody.indexOf(':=');
        while (opIdx !== -1) {
            const target = extractLhsIdentifier(processBody, opIdx);
            if (target) {
                const targetLower = target.toLowerCase();
                assignedSignals.add(targetLower);
                const idStartIdx = processBody.lastIndexOf(target, opIdx);
                if (idStartIdx !== -1) {
                    writeIndices.add(idStartIdx);
                }
            }
            opIdx = processBody.indexOf(':=', opIdx + 2);
        }

        // 2. Extraire tous les identifiants lus (exclure ceux dont l'index commence une affectation LHS et les champs d'enregistrement)
        const idRegex = /\b([a-zA-Z][a-zA-Z0-9_]*)\b/g;
        let idm;
        while ((idm = idRegex.exec(processBody)) !== null) {
            const id = idm[1].toLowerCase();
            if (!VHDL_KEYWORDS.has(id) && !localVariables.has(id)) {
                // Vérifier si l'identifiant est précédé d'un point (ce qui indique un champ d'enregistrement)
                let isField = false;
                let j = idm.index - 1;
                while (j >= 0 && /\s/.test(processBody[j])) {
                    j--;
                }
                if (j >= 0 && processBody[j] === '.') {
                    isField = true;
                }
                
                if (!isField && !writeIndices.has(idm.index)) {
                    readSignals.add(id);
                }
            }
        }

        // Collecter les pilotes pour la détection de conflits (Multiple Drivers)
        const line = documentText.substring(0, processStartIndex).split('\n').length;
        assignedSignals.forEach(sig => {
            if (localVariables.has(sig)) return;
            if (!signalDrivers.has(sig)) {
                signalDrivers.set(sig, []);
            }
            signalDrivers.get(sig).push({
                label: processLabel,
                line: line,
                index: processStartIndex
            });
        });

        // 3. Règle : Interdiction d'écriture sur les ports d'entrée (IN)
        assignedSignals.forEach(sig => {
            if (inPorts.has(sig)) {
                const absoluteIndex = processStartIndex + match[0].indexOf(match[4]) + processBody.toLowerCase().indexOf(sig);
                diagnostics.push({
                    index: absoluteIndex,
                    message: `Questassure DRC: Tentative d'écriture sur le port d'entrée '${sig}'. Un port d'entrée ne peut pas être affecté.`,
                    severity: 'error'
                });
            }
        });

        if (!isSequential) {
            // ==========================================
            // LOGIQUE PROCESSUS COMBINATOIRE
            // ==========================================

            // Règle : Linter de Liste de Sensibilité
            if (!sensList.includes('all')) {
                readSignals.forEach(sig => {
                    if (!sensList.includes(sig) && !assignedSignals.has(sig)) {
                        const absoluteIndex = processStartIndex + match[0].indexOf(match[4]) + processBody.toLowerCase().indexOf(sig);
                        diagnostics.push({
                            index: absoluteIndex,
                            message: `Questassure DRC: Le signal '${sig}' est lu dans ce processus combinatoire mais est absent de la liste de sensibilité.`,
                            severity: 'warning'
                        });
                    }
                });

                sensList.forEach(sig => {
                    if (!readSignals.has(sig) && sig !== 'clk' && sig !== 'clock' && sig !== 'reset' && sig !== 'resetn' && sig !== 'rst' && sig !== 'rstn') {
                        const absoluteIndex = processStartIndex + match[0].indexOf(sensListStr) + sensListStr.toLowerCase().indexOf(sig);
                        diagnostics.push({
                            index: absoluteIndex,
                            message: `Questassure DRC: Le signal '${sig}' est présent dans la liste de sensibilité mais n'est pas lu dans le processus.`,
                            severity: 'info'
                        });
                    }
                });
            }

            // Règle : Détection de Verrous (Latches) Involontaires par AST
            const processAst = parseProcessBody(processBody);
            assignedSignals.forEach(sig => {
                if (localVariables.has(sig)) return;
                
                const isAssignedAllPaths = isSignalAssignedInAllPaths(processAst, sig);
                if (!isAssignedAllPaths) {
                    const absoluteIndex = processStartIndex + match[0].indexOf(match[4]);
                    diagnostics.push({
                        index: absoluteIndex,
                        message: `Questassure DRC: Latch involontaire potentiel détecté pour le signal '${sig}'. Il n'est pas affecté dans tous les chemins d'exécution (il manque une affectation par défaut ou des clauses ELSE/OTHERS d'affectation).`,
                        severity: 'warning'
                    });
                }
            });

            // Règle : Détection de Boucle Combinatoire Directe
            assignedSignals.forEach(sig => {
                if (localVariables.has(sig)) return;
                if (readSignals.has(sig)) {
                    const absoluteIndex = processStartIndex + match[0].indexOf(match[4]) + processBody.toLowerCase().indexOf(sig);
                    diagnostics.push({
                        index: absoluteIndex,
                        message: `Questassure DRC: Boucle combinatoire détectée pour le signal '${sig}'. Il est à la fois lu et affecté dans ce processus combinatoire, ce qui peut créer des oscillations physiques instables.`,
                        severity: 'warning'
                    });
                }
            });

        } else {
            // ==========================================
            // LOGIQUE PROCESSUS SÉQUENTIEL (CLOCKED)
            // ==========================================
            
            // Déterminer le signal d'horloge
            let clockSignal = null;
            const risingEdgeMatch = /rising_edge\s*\(\s*(\w+)\s*\)/i.exec(processBody);
            const fallingEdgeMatch = /falling_edge\s*\(\s*(\w+)\s*\)/i.exec(processBody);
            const eventMatch = /(\w+)\s*'\s*event/i.exec(processBody);
            
            if (risingEdgeMatch) clockSignal = risingEdgeMatch[1].toLowerCase();
            else if (fallingEdgeMatch) clockSignal = fallingEdgeMatch[1].toLowerCase();
            else if (eventMatch) clockSignal = eventMatch[1].toLowerCase();
            
            // Déterminer le signal de reset asynchrone (si présent)
            let resetSignal = null;
            const asyncResetMatch = /\bif\s+(\w+)\s*=\s*'?[01]'?\s+then[\s\S]*?\belsif\b\s*(?:rising_edge|falling_edge|'event)/i.exec(processBody);
            if (asyncResetMatch) {
                resetSignal = asyncResetMatch[1].toLowerCase();
            }
            
            // Valider la liste de sensibilité du processus séquentiel
            if (clockSignal) {
                if (!sensList.includes(clockSignal)) {
                    const absoluteIndex = processStartIndex + match[0].indexOf(match[4]);
                    diagnostics.push({
                        index: absoluteIndex,
                        message: `Questassure DRC: Le signal d'horloge '${clockSignal}' est manquant dans la liste de sensibilité du processus séquentiel.`,
                        severity: 'warning'
                    });
                }
            }
            
            if (resetSignal) {
                if (!sensList.includes(resetSignal)) {
                    const absoluteIndex = processStartIndex + match[0].indexOf(match[4]);
                    diagnostics.push({
                        index: absoluteIndex,
                        message: `Questassure DRC: Le signal de réinitialisation asynchrone '${resetSignal}' est manquant dans la liste de sensibilité du processus séquentiel.`,
                        severity: 'warning'
                    });
                }
            }
            
            // Avertir si des signaux de données superflus sont dans la liste
            sensList.forEach(sig => {
                if (sig !== clockSignal && sig !== resetSignal) {
                    const absoluteIndex = processStartIndex + match[0].indexOf(sensListStr) + sensListStr.toLowerCase().indexOf(sig);
                    diagnostics.push({
                        index: absoluteIndex,
                        message: `Questassure DRC: Le signal '${sig}' ne devrait pas être dans la liste de sensibilité d'un processus séquentiel (seuls l'horloge et la réinitialisation asynchrone doivent y figurer).`,
                        severity: 'info'
                    });
                }
            });
        }
    }

    // ==========================================
    // RÈGLE : Détection de Pilotes Multiples (Multiple Drivers)
    // ==========================================
    signalDrivers.forEach((drivers, sig) => {
        if (drivers.length > 1) {
            drivers.forEach(driver => {
                const otherDrivers = drivers.filter(d => d.index !== driver.index);
                const otherLinesStr = otherDrivers.map(d => `ligne ${d.line}`).join(', ');
                diagnostics.push({
                    index: driver.index,
                    message: `Questassure DRC: Conflit de pilotes multiples pour le signal '${sig}'. Il est également affecté dans d'autres processus (ex: à la ${otherLinesStr}).`,
                    severity: 'warning'
                });
            });
        }
    });

    return diagnostics;
}

/**
 * Analyse les déclarations mortes (non utilisées, lues sans affectation, ou affectées sans lecture) :
 * - Signaux, variables locales, constantes et paramètres génériques.
 *
 * @param {string} documentText - Le code source brut du document.
 * @returns {Object[]} Liste des diagnostics de code mort trouvés.
 */
function analyzeDeadCode(documentText) {
    const diagnostics = [];
    const cleanText = stripComments(documentText);
    const declarations = [];

    // 1. Recherche des déclarations de signaux
    const signalRegex = /\bsignal\s+([a-zA-Z0-9_,\s]+)\s*:/gi;
    let sm;
    while ((sm = signalRegex.exec(cleanText)) !== null) {
        const namesStr = sm[1];
        const names = namesStr.split(',').map(n => n.trim());
        const startIdx = sm.index + sm[0].indexOf(namesStr);
        for (const name of names) {
            if (name && !VHDL_KEYWORDS.has(name.toLowerCase())) {
                const nameIdx = startIdx + namesStr.indexOf(name);
                declarations.push({ name: name.toLowerCase(), originalName: name, type: 'signal', index: nameIdx });
            }
        }
    }

    // 2. Recherche des déclarations de constantes
    const constRegex = /\bconstant\s+([a-zA-Z0-9_,\s]+)\s*:/gi;
    let cm;
    while ((cm = constRegex.exec(cleanText)) !== null) {
        const namesStr = cm[1];
        const names = namesStr.split(',').map(n => n.trim());
        const startIdx = cm.index + cm[0].indexOf(namesStr);
        for (const name of names) {
            if (name && !VHDL_KEYWORDS.has(name.toLowerCase())) {
                const nameIdx = startIdx + namesStr.indexOf(name);
                declarations.push({ name: name.toLowerCase(), originalName: name, type: 'constant', index: nameIdx });
            }
        }
    }

    // 3. Recherche des déclarations de variables
    const varRegex = /\bvariable\s+([a-zA-Z0-9_,\s]+)\s*:/gi;
    let vm;
    while ((vm = varRegex.exec(cleanText)) !== null) {
        const namesStr = vm[1];
        const names = namesStr.split(',').map(n => n.trim());
        const startIdx = vm.index + vm[0].indexOf(namesStr);
        for (const name of names) {
            if (name && !VHDL_KEYWORDS.has(name.toLowerCase())) {
                const nameIdx = startIdx + namesStr.indexOf(name);
                declarations.push({ name: name.toLowerCase(), originalName: name, type: 'variable', index: nameIdx });
            }
        }
    }

    // 4. Recherche des paramètres génériques
    const genericBlockRegex = /\bgeneric\s*\(([\s\S]*?)\)\s*;/gi;
    let gbm;
    while ((gbm = genericBlockRegex.exec(cleanText)) !== null) {
        const block = gbm[1];
        const blockStart = gbm.index + gbm[0].indexOf(block);
        const genRegex = /\b([a-zA-Z0-9_,\s]+)\s*:/gi;
        let genMatch;
        while ((genMatch = genRegex.exec(block)) !== null) {
            const namesStr = genMatch[1];
            const names = namesStr.split(',').map(n => n.trim());
            const startIdx = blockStart + genMatch.index + genMatch[0].indexOf(namesStr);
            for (const name of names) {
                if (name && !VHDL_KEYWORDS.has(name.toLowerCase())) {
                    const nameIdx = startIdx + namesStr.indexOf(name);
                    declarations.push({ name: name.toLowerCase(), originalName: name, type: 'generic', index: nameIdx });
                }
            }
        }
    }

    // Déterminer la portée géographique de toutes les maps de ports (port maps) pour s'en prémunir
    const portMaps = [];
    const portMapRegex = /\bport\s+map\s*\(([\s\S]*?)\)/gi;
    let pmm;
    while ((pmm = portMapRegex.exec(cleanText)) !== null) {
        portMaps.push({
            start: pmm.index,
            end: pmm.index + pmm[0].length
        });
    }

    // Extraire toutes les écritures (affectations) du document entier pour identifier les LHS de façon robuste
    const globalWriteIndices = new Set();
    
    let opIdx = cleanText.indexOf('<=');
    while (opIdx !== -1) {
        const target = extractLhsIdentifier(cleanText, opIdx);
        if (target) {
            const idStartIdx = cleanText.lastIndexOf(target, opIdx);
            if (idStartIdx !== -1) {
                globalWriteIndices.add(idStartIdx);
            }
        }
        opIdx = cleanText.indexOf('<=', opIdx + 2);
    }
    
    opIdx = cleanText.indexOf(':=');
    while (opIdx !== -1) {
        const target = extractLhsIdentifier(cleanText, opIdx);
        if (target) {
            const idStartIdx = cleanText.lastIndexOf(target, opIdx);
            if (idStartIdx !== -1) {
                globalWriteIndices.add(idStartIdx);
            }
        }
        opIdx = cleanText.indexOf(':=', opIdx + 2);
    }

    // Analyser l'utilisation de chaque élément déclaré
    for (const decl of declarations) {
        const name = decl.name;
        const occurrences = [];
        const wordRegex = new RegExp(`\\b${name}\\b`, 'gi');
        let wm;
        while ((wm = wordRegex.exec(cleanText)) !== null) {
            occurrences.push(wm.index);
        }

        // Si l'occurrence n'est trouvée qu'une fois (la déclaration elle-même), le symbole est mort/inutilisé.
        if (occurrences.length <= 1) {
            let typeLabel = "";
            if (decl.type === 'signal') typeLabel = "Le signal";
            else if (decl.type === 'constant') typeLabel = "La constante";
            else if (decl.type === 'variable') typeLabel = "La variable";
            else if (decl.type === 'generic') typeLabel = "Le paramètre générique";

            diagnostics.push({
                index: decl.index,
                message: `Questassure DRC: ${typeLabel} '${decl.originalName}' est déclaré mais n'est jamais utilisé.`,
                severity: 'info'
            });
            continue;
        }

        let hasWrite = false;
        let hasRead = false;

        for (const occIndex of occurrences) {
            // Ignorer l'occurrence de la déclaration elle-même
            if (Math.abs(occIndex - decl.index) < name.length) {
                continue;
            }

            // Si le symbole apparaît dans une map de port, on suppose par précaution qu'il est lu et écrit
            const inPortMap = portMaps.some(pm => occIndex >= pm.start && occIndex <= pm.end);
            if (inPortMap) {
                hasWrite = true;
                hasRead = true;
                continue;
            }

            // Vérifier s'il s'agit d'une affectation (présence dans globalWriteIndices)
            if (globalWriteIndices.has(occIndex)) {
                hasWrite = true;
            } else {
                hasRead = true;
            }
        }

        // Générer des diagnostics d'affectations orphelines
        if (decl.type === 'signal') {
            if (!hasWrite) {
                diagnostics.push({
                    index: decl.index,
                    message: `Questassure DRC: Le signal '${decl.originalName}' est lu mais n'est jamais affecté.`,
                    severity: 'warning'
                });
            } else if (!hasRead) {
                diagnostics.push({
                    index: decl.index,
                    message: `Questassure DRC: Le signal '${decl.originalName}' est affecté mais n'est jamais lu.`,
                    severity: 'info'
                });
            }
        } else if (decl.type === 'variable') {
            if (!hasWrite) {
                diagnostics.push({
                    index: decl.index,
                    message: `Questassure DRC: La variable '${decl.originalName}' est lue mais n'est jamais affectée.`,
                    severity: 'warning'
                });
            } else if (!hasRead) {
                diagnostics.push({
                    index: decl.index,
                    message: `Questassure DRC: La variable '${decl.originalName}' est affectée mais n'est jamais lue.`,
                    severity: 'info'
                });
            }
        }
    }

    return diagnostics;
}

/**
 * Lance le linter DRC de Questassure sur un fichier VHDL ouvert.
 * Calcule les anomalies syntaxiques et les ajoute aux diagnostics de l'IDE.
 *
 * @param {vscode.TextDocument} document - Le document VS Code actif.
 * @param {vscode.DiagnosticCollection} collection - La collection des diagnostics de l'extension.
 */
function runDrcLinter(document, collection) {
    if (document.languageId !== 'vhdl') return;

    try {
        const text = document.getText();
        const processResults = analyzeVhdlCode(text);
        const deadCodeResults = analyzeDeadCode(text);
        const results = [...processResults, ...deadCodeResults];

        // Conserver les diagnostics GHDL existants et y fusionner nos diagnostics DRC
        const currentDiagnostics = collection.get(document.uri) || [];
        // Filtrer les anciens diagnostics DRC pour éviter les doublons à chaque saisie
        const filteredDiagnostics = currentDiagnostics.filter(d => !d.message.startsWith('Questassure DRC:'));

        const newDiagnostics = [...filteredDiagnostics];

        results.forEach(res => {
            const pos = document.positionAt(res.index);
            const range = new vscode.Range(pos.line, pos.character, pos.line, pos.character + 15);
            
            let severity = vscode.DiagnosticSeverity.Warning;
            if (res.severity === 'info') {
                severity = vscode.DiagnosticSeverity.Information;
            } else if (res.severity === 'error') {
                severity = vscode.DiagnosticSeverity.Error;
            }

            const diag = new vscode.Diagnostic(range, res.message, severity);
            diag.source = 'Questassure DRC';
            newDiagnostics.push(diag);
        });

        collection.set(document.uri, newDiagnostics);
    } catch (e) {
        console.error("DRC Linter run failed:", e);
    }
}

module.exports = {
    analyzeVhdlCode,
    analyzeDeadCode,
    runDrcLinter
};
