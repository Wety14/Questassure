# Questassure

Questassure est une extension VS Code pour le développement et la simulation en VHDL-2008. Elle intègre des outils de productivité avancés s'appuyant sur des briques open source solides :

* **GHDL** pour l'analyse syntaxique, la vérification des dépendances et la simulation.
* **Yosys** pour la synthèse logique et l'extraction de schémas RTL.
* **Surfer** et un visualiseur VCD intégré pour l'affichage de chronogrammes.

Le code source de l'extension se trouve dans le dossier [vscode-extension/](file:///Users/user/Documents/Questassure/vscode-extension).

---

## 🚀 Installation & Prérequis

Pour utiliser pleinement l'extension, vous devez disposer de **GHDL**, **Yosys** et **Surfer** sur votre système.

### 1. macOS
Installez toutes les dépendances via Homebrew :
```bash
brew install ghdl yosys surfer
```

### 2. Linux (Ubuntu/Debian)
Installez GHDL et Yosys depuis votre gestionnaire de paquets, et Surfer via Cargo :
```bash
sudo apt update && sudo apt install ghdl yosys
cargo install surfer
```

### 3. Windows
1. Téléchargez et extrayez [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) (contient GHDL et Yosys).
2. Téléchargez l'exécutable [Surfer](https://github.com/surfer-project/surfer/releases).
3. Ajoutez le dossier `bin` d'OSS CAD Suite et le dossier contenant `surfer.exe` à votre variable d'environnement `PATH`.

---

## ✨ Fonctionnalités clés

### 1. Édition intelligente & Formatage
* **Coloration syntaxique** : Thème personnalisé VHDL pour VS Code.
* **Diagnostics en temps réel** : Analyse sémantique continue via GHDL, détection de signaux manquants dans les listes de sensibilité et détection de verrous (*latches*) combinatoires involontaires.
* **Formatage automatique** : Indentation automatique, alignement intelligent des `:` et alignement des `<=` sous conditions.

### 2. Outils Visuels
* **Schémas RTL & Graphes FSM interactifs** : Rendu dynamique des portes logiques et diagrammes d'états à partir du code VHDL avec navigation bidirectionnelle (cross-probing).
* **FSM Designer** : Outil graphique interactif pour concevoir, modifier et sauvegarder des machines à états directement générées en code VHDL.
* **Chronogrammes intégrés** : Visualiseur de waveforms intégré basé sur le format VCD avec gestion des presets de signaux.

### 3. Test Explorer & LSP
* **Test Explorer** : Détection automatique des entités de testbench et lancement de simulations depuis le panneau de test VS Code.
* **Navigation dans le code** : Aller à la définition (F12), Trouver les références (Shift+F12) et Vue structurelle du document.
* **Générateurs de code** : Autocomplétion intelligente des port maps, instanciation automatique de composants et modèles pré-configurés de testbenches/FSM.

---

## 🛠️ Développement & Compilation

Si vous souhaitez modifier ou compiler l'extension localement :

1. Naviguez dans le dossier de l'extension :
   ```bash
   cd vscode-extension
   ```
2. Installez les dépendances npm :
   ```bash
   npm install
   ```
3. Compilez et packagez le code de l'extension :
   ```bash
   npm run vscode:prepublish
   ```
4. Pour générer un package installable `.vsix` :
   ```bash
   npx vsce package
   ```
