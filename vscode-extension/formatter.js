/**
 * @file formatter.js
 * @brief Formateur de code source VHDL.
 * Fournit des fonctionnalités de mise en minuscule des mots-clés,
 * d'indentation automatique par gestion de pile, et d'alignement des
 * deux-points (:) dans les déclarations et des affectations.
 */

/**
 * Ensemble des mots-clés, types de base et bibliothèques standards VHDL
 * qui doivent être convertis en minuscules lors du formatage.
 */
const keywordsToLowercase = new Set([
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
    "std_logic", "std_logic_vector", "string", "time", "unsigned",
    "ieee", "std", "work", "std_logic_1164", "numeric_std", "std_logic_arith", "std_logic_unsigned", "std_logic_signed"
]);

/**
 * Convertit tous les mots-clés VHDL d'une portion de code en minuscules,
 * tout en ignorant le contenu des chaînes de caractères et des littéraux de caractères.
 *
 * @param {string} codePart - La portion de code à traiter.
 * @returns {string} Le code avec les mots-clés en minuscules.
 */
function lowercaseKeywords(codePart) {
    const pattern = /"[^"]*"|'[^']'|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
    return codePart.replace(pattern, (token) => {
        if (token.startsWith('"') || token.startsWith("'")) {
            return token; // Ne pas modifier les chaînes ou caractères littéraux
        }
        const lowerToken = token.toLowerCase();
        if (keywordsToLowercase.has(lowerToken)) {
            return lowerToken;
        }
        return token;
    });
}

/**
 * Divise une ligne de code VHDL en deux parties : le code utile et le commentaire de fin de ligne.
 * Gère correctement le symbole `--` en vérifiant qu'il n'est pas dans une chaîne de caractères.
 *
 * @param {string} line - La ligne de code brute.
 * @returns {[string, string]} Un tableau contenant [partie_code, partie_commentaire].
 */
function splitLine(line) {
    let inString = false;
    let commentStart = -1;
    let i = 0;
    const n = line.length;
    while (i < n) {
        if (line[i] === '"') {
            inString = !inString;
            i += 1;
        } else if (!inString && i + 1 < n && line[i] === '-' && line[i+1] === '-') {
            commentStart = i;
            break;
        } else {
            i += 1;
        }
    }
    if (commentStart !== -1) {
        return [line.slice(0, commentStart), line.slice(commentStart)];
    }
    return [line, ""];
}

/**
 * Recherche l'index du caractère deux-points (:) de déclaration dans une ligne de code.
 * Ignore les deux-points situés dans les chaînes ou faisant partie de l'affectation `:=`.
 *
 * @param {string} codeStr - Le code de la ligne nettoyé.
 * @returns {number} L'index du deux-points de déclaration, ou -1 s'il n'est pas trouvé.
 */
function findDeclColon(codeStr) {
    let inString = false;
    let i = 0;
    const n = codeStr.length;
    while (i < n) {
        if (codeStr[i] === '"') {
            inString = !inString;
            i += 1;
        } else if (!inString && codeStr[i] === ':') {
            if (i + 1 < n && codeStr[i+1] === '=') {
                i += 2; // Ignorer l'opérateur d'affectation ':='
            } else {
                return i;
            }
        } else {
            i += 1;
        }
    }
    return -1;
}

/**
 * Formate un code source VHDL complet.
 * Gère l'indentation par blocs, l'alignement des déclarations successives,
 * et l'alignement vertical des affectations conditionnelles multi-lignes.
 *
 * @param {string} code - Le code source VHDL brut.
 * @returns {string} Le code source VHDL formaté.
 */
function formatVhdl(code) {
    const lines = code.split(/\r?\n/);
    const formattedLines = [];
    const stack = []; // Pile pour suivre les structures ouvertes (if, process, loop, etc.)
    let parenDepth = 0; // Profondeur des parenthèses
    let portParenDepth = -1; // Profondeur au début d'un bloc port/generic
    const lineDetails = [];

    // --- Première passe : Indentation et mise en minuscule des mots-clés ---
    for (let line of lines) {
        if (!line.trim()) {
            formattedLines.push("");
            lineDetails.push({ isDecl: false, declColonInCheck: -1, indentLen: 0 });
            continue;
        }

        const [codePart, commentPart] = splitLine(line);
        const codePartLower = lowercaseKeywords(codePart);

        // Sortie de la zone de ports/génériques si la profondeur de parenthèses redescend
        if (portParenDepth !== -1 && parenDepth < portParenDepth) {
            portParenDepth = -1;
        }

        const isInsidePortGeneric = (portParenDepth !== -1 && parenDepth >= portParenDepth);

        // Analyse lexicale simplifiée en masquant les chaînes de caractères
        let codeNoStrings = codePartLower.replace(/"[^"]*"/g, '""');
        codeNoStrings = codeNoStrings.replace(/'[^']'/g, "'x'");

        const words = codeNoStrings.match(/[a-zA-Z_][a-zA-Z0-9_]*|[()=]|<=|:=|=>/g) || [];

        let isOutdent = false;
        if (words.length > 0) {
            const firstWord = words[0];
            // Détection du désindentation immédiat pour 'end', 'begin', 'else', etc.
            if (firstWord === 'end') {
                if (stack.length > 0 && stack[stack.length - 1] === 'when') {
                    stack.pop();
                }
                if (stack.length > 0) {
                    stack.pop();
                }
                isOutdent = true;
            } else if (['begin', 'else', 'elsif', 'when'].includes(firstWord)) {
                if (firstWord === 'when') {
                    if (stack.length > 0 && stack[stack.length - 1] === 'when') {
                        stack.pop();
                    }
                }
                isOutdent = true;
            }
        }

        const firstChar = codePart.trim()[0] || "";
        let tempParenOffset = 0;
        if (firstChar === ')') {
            tempParenOffset = -1; // Ajuster temporairement l'indentation si la ligne commence par une parenthèse fermante
        }

        let level = stack.length + parenDepth + tempParenOffset;
        if (isOutdent && !(words.length > 0 && words[0] === 'end')) {
            level = Math.max(0, level - 1);
        }

        const indent = " ".repeat(4 * level);
        let formattedLine = "";
        if (codePart.trim()) {
            if (commentPart) {
                formattedLine = indent + codePartLower.trim() + " " + commentPart.trimEnd();
            } else {
                formattedLine = indent + codePartLower.trim();
            }
        } else {
            formattedLine = indent + commentPart.trimEnd();
        }
        formattedLines.push(formattedLine.trimEnd());

        // Déterminer s'il s'agit d'une déclaration de signal/variable/port
        const declColonInCheck = findDeclColon(codePart.trim());
        const isDecl = (declColonInCheck !== -1) && (
            isInsidePortGeneric ||
            words.some(w => ['signal', 'variable', 'constant', 'port', 'generic'].includes(w))
        );

        lineDetails.push({
            isDecl: isDecl,
            declColonInCheck: declColonInCheck,
            indentLen: 4 * level
        });

        // Mise à jour de la pile d'indentation selon les structures rencontrées
        if (words.length > 0) {
            const firstWord = words[0];
            if (firstWord !== 'end') {
                if (words.includes('then') && firstWord !== 'elsif') {
                    stack.push('if');
                } else if (words.includes('loop')) {
                    stack.push('loop');
                } else if (words.includes('process')) {
                    stack.push('process');
                } else if (words.includes('case')) {
                    stack.push('case');
                } else if (words.includes('record')) {
                    stack.push('record');
                } else if (words.includes('generate')) {
                    stack.push('generate');
                } else if (words.includes('units')) {
                    stack.push('units');
                } else if (words.includes('component')) {
                    stack.push('component');
                } else if (words.includes('package')) {
                    stack.push('package');
                } else if (words.includes('block')) {
                    stack.push('block');
                } else if (words.includes('architecture') && words.includes('is')) {
                    stack.push('architecture');
                } else if (words.includes('entity') && words.includes('is')) {
                    stack.push('entity');
                } else if (words.includes('configuration') && words.includes('is')) {
                    stack.push('configuration');
                } else if (firstWord === 'when') {
                    stack.push('when');
                }

                // Détection de l'ouverture d'un bloc de ports ou de paramètres génériques
                if ((words.includes('port') || words.includes('generic')) && !words.includes('end')) {
                    let openCount = 0;
                    for (let char of codePartLower) {
                        if (char === '(') openCount++;
                    }
                    portParenDepth = parenDepth + openCount;
                }
            }
        }

        // Suivi global de la profondeur des parenthèses
        for (let char of codePartLower) {
            if (char === '(') {
                parenDepth += 1;
            } else if (char === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
            }
        }
    }

    // --- Deuxième passe : Alignement des colons (:) dans les blocs de déclaration ---
    const groups = [];
    let currentGroup = [];

    for (let idx = 0; idx < formattedLines.length; idx++) {
        const line = formattedLines[idx];
        const [codePart, commentPart] = splitLine(line);
        const isEmptyOrComment = !codePart.trim();
        const details = lineDetails[idx];

        if (details.isDecl) {
            currentGroup.push(idx);
        } else if (isEmptyOrComment) {
            // Permet aux lignes vides ou commentaires de ne pas casser le groupe s'ils sont entourés de déclarations
            if (currentGroup.length > 0) {
                currentGroup.push(idx);
            }
        } else {
            if (currentGroup.length > 0) {
                // Nettoyer les lignes vides/commentaires à la fin du groupe
                while (currentGroup.length > 0) {
                    const lastIdx = currentGroup[currentGroup.length - 1];
                    if (!splitLine(formattedLines[lastIdx])[0].trim()) {
                        currentGroup.pop();
                    } else {
                        break;
                    }
                }
                const declCount = currentGroup.filter(i => lineDetails[i].isDecl).length;
                if (declCount >= 2) {
                    groups.push(currentGroup);
                }
                currentGroup = [];
            }
        }
    }

    // Traiter le dernier groupe résiduel
    if (currentGroup.length > 0) {
        while (currentGroup.length > 0) {
            const lastIdx = currentGroup[currentGroup.length - 1];
            if (!splitLine(formattedLines[lastIdx])[0].trim()) {
                currentGroup.pop();
            } else {
                break;
            }
        }
        const declCount = currentGroup.filter(i => lineDetails[i].isDecl).length;
        if (declCount >= 2) {
            groups.push(currentGroup);
        }
    }

    // Appliquer l'alignement sur les colons pour chaque groupe identifié
    for (const group of groups) {
        let maxLen = 0;
        for (const idx of group) {
            const details = lineDetails[idx];
            if (details.isDecl) {
                const line = formattedLines[idx];
                const [codePart, _] = splitLine(line);
                const declColonInCheck = details.declColonInCheck;
                const indent = " ".repeat(details.indentLen);

                const leftCode = indent + codePart.trim().slice(0, declColonInCheck).trim();
                maxLen = Math.max(maxLen, leftCode.length);
            }
        }

        for (const idx of group) {
            const details = lineDetails[idx];
            if (details.isDecl) {
                const line = formattedLines[idx];
                const [codePart, commentPart] = splitLine(line);
                const declColonInCheck = details.declColonInCheck;
                const indent = " ".repeat(details.indentLen);

                const leftCodeStripped = codePart.trim().slice(0, declColonInCheck).trim();
                const rightCode = codePart.trim().slice(declColonInCheck + 1).trim();

                const padding = " ".repeat(maxLen - details.indentLen - leftCodeStripped.length);
                const alignedCode = indent + leftCodeStripped + padding + " : " + rightCode;

                if (commentPart) {
                    formattedLines[idx] = alignedCode + " " + commentPart;
                } else {
                    formattedLines[idx] = alignedCode;
                }
            }
        }
    }

    // --- Troisième passe : Alignement des affectations conditionnelles multi-lignes ---
    let idx = 0;
    const numLines = formattedLines.length;
    while (idx < numLines) {
        const line = formattedLines[idx];
        const [codePart, _] = splitLine(line);

        if (codePart.includes('<=')) {
            const assignPos = codePart.indexOf('<=');
            const valPart = codePart.slice(assignPos + 2);
            const strippedVal = valPart.trimStart();
            if (strippedVal) {
                const firstValOffset = valPart.length - strippedVal.length;
                const alignIdx = assignPos + 2 + firstValOffset;

                // Si la ligne se termine par 'else', aligner les lignes d'affectation suivantes
                const wordsInLine = codePart.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
                if (wordsInLine.length > 0 && wordsInLine[wordsInLine.length - 1] === 'else') {
                    const group = [];
                    let scanIdx = idx + 1;
                    while (scanIdx < numLines) {
                        const subLine = formattedLines[scanIdx];
                        const [subCode, _] = splitLine(subLine);

                        if (!subCode.trim()) {
                            scanIdx += 1;
                            continue;
                        }

                        group.push(scanIdx);

                        const subStripped = subCode.trim();
                        if (subStripped.includes(';')) {
                            break; // Fin de l'instruction d'affectation
                        }
                        scanIdx += 1;
                    }

                    if (group.length > 0) {
                        for (const gIdx of group) {
                            const subLine = formattedLines[gIdx];
                            const [subCode, commentPart] = splitLine(subLine);
                            const subStripped = subCode.trim();

                            if (subStripped) {
                                const indent = " ".repeat(alignIdx);
                                const alignedCode = indent + subStripped;
                                if (commentPart) {
                                    formattedLines[gIdx] = alignedCode + " " + commentPart;
                                } else {
                                    formattedLines[gIdx] = alignedCode;
                                }
                            }
                        }
                        idx = group[group.length - 1];
                    }
                }
            }
        }
        idx += 1;
    }

    return formattedLines.join("\n");
}

module.exports = {
    formatVhdl,
    splitLine,
    lowercaseKeywords,
    findDeclColon
};
