# Extension Questassure VHDL pour VS Code

[![Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Questassure-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode)

L'extension officielle est disponible sur le [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DARIER--LEGRAND.questassure-vscode).

Cette extension intègre les outils de productivité VHDL de **Questassure** directement dans VS Code, offrant la coloration syntaxique, des diagnostics en temps réel, le formatage, des simulations, des schémas interactifs et un outil graphique de conception de FSM.

---

## 🚀 Installation & Prérequis

Pour utiliser cette extension, **GHDL**, **Yosys** et **Surfer** doivent être installés sur votre système.

### 1. macOS
Installez toutes les dépendances via Homebrew :
```bash
brew install ghdl yosys surfer
```

### 2. Linux
Installez via votre gestionnaire de paquets :
```bash
sudo apt update && sudo apt install ghdl yosys
cargo install surfer
```

### 3. Windows
1. Téléchargez et extrayez [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) (regroupe GHDL et Yosys).
2. Téléchargez [Surfer](https://github.com/surfer-project/surfer/releases).
3. Ajoutez le dossier `bin` d'OSS CAD Suite et le dossier contenant `surfer.exe` à votre variable d'environnement `PATH` :
   - Appuyez sur la **touche Windows**, tapez `variables d'environnement` et sélectionnez **Modifier les variables d'environnement système**.
   - Cliquez sur **Variables d'environnement...**.
   - Sous *Variables utilisateur* ou *Variables système*, sélectionnez **Path** et cliquez sur **Modifier...**.
   - Cliquez sur **Nouveau** et ajoutez les chemins absolus des dossiers.
   - Cliquez sur **OK** sur toutes les fenêtres et redémarrez VS Code.

---

## ✨ Fonctionnalités clés

### 1. Édition intelligente & Formatage
* **Coloration syntaxique** : Thème personnalisé Questassure VHDL.
* **Sauvegarde automatique** : Sauvegarde après 1000 ms d'inactivité.
* **Diagnostics en direct** : Analyse syntaxique avec GHDL, vérificateur de liste de sensibilité et détecteur de verrous (latches).
* **Formatage du code** : Indentation à 4 espaces, alignement des colons et alignement conditionnel `<=` .

### 2. Outils visuels
* **Schémas RTL & Graphes FSM interactifs** : Rendu des portes logiques et diagrammes d'états à partir du code avec cross-probing bidirectionnel.
* **FSM Designer** : Concepteur visuel pour créer, éditer et sauvegarder graphiquement des FSM directement en code VHDL.
* **Visualiseur de chronogrammes intégré** : Panneau de chronogrammes SVG intégré avec presets de signaux.

### 3. Explorateur de tests & LSP
* **Explorateur de tests** : Détecte et lance les testbenches VHDL depuis le panneau de test natif de VS Code.
* **Navigation dans le code** : Aller à la définition (F12), Trouver les références (Shift+F12), Structure du document.
* **Générateurs de code** : Autocomplétion de port map, instanciation de composant (presse-papiers ou projet) et modèles de testbenches/FSM.

### 4. 🤖 Serveur MCP (Model Context Protocol) pour Assistants IA
* **Outils EDA universels pour LLMs** : Connecte les modèles d'IA (Claude, Antigravity, Cursor, Windsurf, Codex...) directement aux moteurs de simulation GHDL, de synthèse Yosys et d'ondes VCD.
* **11 Outils MCP natifs** : Simulation de testbench, inspection d'ondes VCD, exécution de la suite de tests, analyse syntaxique GHDL, détection DRC de verrous (latches), estimation de ressources Yosys, analyse FSM & diagrammes Mermaid, génération de testbenches et formatage VHDL.
* **Ressources & Modèles de Prompts** : Guides de conception VHDL synthétisable et workflows IA pré-configurés pour la génération de tests, le débogage de simulation et la conception de FSM.
* **Export de configuration en 1 clic** : Exécutez la commande `Questassure : Copier la configuration MCP pour assistants IA` dans VS Code pour obtenir une configuration instantanée prête à l'emploi.

---

## 🤖 Guide & Architecture MCP (Model Context Protocol)

### Qu'est-ce que le Model Context Protocol (MCP) ?
Le **Model Context Protocol (MCP)** est un protocole standard ouvert conçu pour permettre aux modèles d'IA générative (LLMs) d'interagir directement et en toute sécurité avec des outils locaux, le système de fichiers et des environnements d'exécution.

Plutôt que de laisser l'IA "deviner" le résultat d'une simulation VHDL ou d'un chronogramme, le serveur MCP Questassure permet à l'assistant IA de :
1. **Compiler et exécuter** des simulations réelles avec GHDL en boucle autonome.
2. **Inspecter les chronogrammes (VCD)** pour lire la valeur des signaux et fronts d'horloge à des instants précis.
3. **Lancer des vérifications de règles de conception (DRC)** pour éliminer les verrous involontaires (*latches*) et les signaux manquants.
4. **Synthétiser des circuits avec Yosys** pour évaluer la consommation en bascules D (DFF) et portes logiques.

```
+-----------------------------------------------------------------------+
|                       Clients IA / IDEs                               |
|   Claude Desktop  |  Cursor  |  Antigravity  |  Windsurf  |  Copilot  |
+-----------------------------------------------------------------------+
                                  | (JSON-RPC 2.0 sur stdio)
                                  v
+-----------------------------------------------------------------------+
|                    Serveur MCP Questassure                            |
|                    (dist/mcp-server.js)                               |
+-----------------------------------------------------------------------+
         |                       |                      |
         v                       v                      v
    Moteur GHDL            Synthèse Yosys          Ondes VCD & DRC
(Simulation & Lint)     (Estimation Ressources)   (Inspecter & Analyser)
```

---

### 📦 Configuration rapide pour les principaux services IA

Vous pouvez générer automatiquement votre configuration dans VS Code en ouvrant la Palette de commandes (`Ctrl+Shift+P` / `Cmd+Shift+P`) et en choisissant :
> **`Questassure : Copier la configuration MCP pour assistants IA (Claude, Cursor, Antigravity...)`**

Vous pouvez également renseigner la configuration manuellement selon votre client préféré :

#### 1. Claude Desktop
Éditez votre fichier `claude_desktop_config.json` :
* **macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows** : `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux** : `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/CHEMIN/ABSOLU/VERS/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 2. Cursor IDE
Ajoutez dans le fichier `.cursor/mcp.json` de votre projet ou dans **Paramètres Cursor > Features > MCP** :
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/CHEMIN/ABSOLU/VERS/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 3. Google Antigravity / Gemini Code Assist
Ajoutez dans la configuration MCP d'Antigravity :
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/CHEMIN/ABSOLU/VERS/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 4. Windsurf (Codeium)
Ajoutez dans `~/.codeium/windsurf/mcp_config.json` :
```json
{
  "mcpServers": {
    "questassure": {
      "command": "node",
      "args": ["/CHEMIN/ABSOLU/VERS/questassure-vscode/dist/mcp-server.js"]
    }
  }
}
```

#### 5. Roo Code / Cline / Autres clients MCP génériques
```json
{
  "name": "questassure",
  "command": "node",
  "args": ["/CHEMIN/ABSOLU/VERS/questassure-vscode/dist/mcp-server.js"],
  "transport": "stdio"
}
```

---

### 🛠️ Liste des outils MCP disponibles

| Outil MCP | Description |
| :--- | :--- |
| `simulate_testbench` | Compile et simule un testbench avec GHDL, retourne les logs, les assertions et le chemin VCD. |
| `inspect_waveform` | Lit un fichier `.vcd` et retourne les transitions exactes des signaux sur une fenêtre temporelle. |
| `run_project_tests` | Découvre et exécute automatiquement tous les bancs d'essai du projet avec compte-rendu. |
| `check_syntax_and_types` | Vérification syntaxique et sémantique en temps réel avec diagnostics GHDL ligne/colonne. |
| `detect_hardware_hazards` | DRC Questassure : détecte les verrous (*latches*), listes de sensibilité incomplètes et code mort. |
| `synthesize_and_estimate_resources` | Synthétise le circuit avec Yosys, estime les bascules D, LUTs et vérifie la synthétisabilité. |
| `get_project_hierarchy` | Retourne la hiérarchie AST de toutes les entités, architectures, paquetages et bancs d'essai. |
| `get_entity_interface` | Analyse les ports d'une entité (nom, direction, type), ses génériques et sa documentation. |
| `analyze_fsm` | Analyse les machines à états finis, extrait les matrices de transition et génère des diagrammes Mermaid. |
| `generate_testbench` | Génère le code complet d'un banc d'essai VHDL avec gestion d'horloge, reset et stimulus. |
| `format_vhdl` | Formate et aligne automatiquement le code source VHDL selon les standards Questassure. |

---

## ⚙️ Paramètres

* `questassure.ghdlPath` (défaut : `"ghdl"`) : Chemin vers l'exécutable GHDL.
* `questassure.stopTime` (défaut : `"1us"`) : Temps d'arrêt par défaut de la simulation.
* `questassure.language` (défaut : `"auto"`) : Langue de l'extension (`auto`, `en`, `fr`).
* `questassure.openWavesOnTestExplorerRun` (défaut : `true`) : Ouvrir automatiquement le chronogramme lors des tests.

---

## 🛠️ Installation via le Marketplace

* **Marketplace VS Code** : Recherchez **Questassure VHDL** et cliquez sur **Installer**.
* **Package VSIX** : Ouvrez la palette de commandes (`Ctrl+Shift+P`), sélectionnez **Extensions: Install from VSIX...** et choisissez le fichier `.vsix`.

---

## 📜 Crédits & Prérequis matériels/logiciels

* **GHDL** : Requiert une installation système et la présence de l'exécutable dans le `PATH` (ou configuré).
* **Yosys** : Requiert une installation système et la présence de l'exécutable dans le `PATH`.
* **Surfer** : Requiert une installation système et la présence de l'exécutable dans le `PATH`.
