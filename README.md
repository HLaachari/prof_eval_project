# Classia

Application web de suivi pédagogique pour un professeur d’informatique. Les cinq classes et leurs élèves sont initialisés depuis les exports Excel fournis, puis enregistrés dans PostgreSQL ou MySQL/MariaDB.

## Lancer localement

1. Copier `.env.example` vers `.env` et renseigner `DATABASE_URL`.
2. Installer les dépendances et démarrer Classia depuis la racine du projet :

```powershell
npm install
npm start
```

Puis ouvrir `http://localhost:4173`.

Le moteur est détecté automatiquement : une URL `postgresql://` utilise PostgreSQL et une URL `mysql://` utilise MySQL/MariaDB. Le serveur crée automatiquement une base PostgreSQL locale si l’utilisateur l’autorise. Sur MySQL/Hostinger, la base doit être créée depuis hPanel ; le serveur crée ensuite ses tables. La chaîne de connexion reste côté serveur dans `.env` et n’est jamais exposée au navigateur.

Les contrôles, notes, séances, présences, points et observations sont synchronisés dans le moteur configuré. Le stockage local du navigateur sert de sauvegarde hors ligne. Si la base est vide au premier démarrage, les données déjà présentes dans le navigateur sont importées automatiquement.

Vérification de la connexion :

```powershell
Invoke-RestMethod http://localhost:4173/api/health
```

La réponse indique aussi le moteur actif dans le champ `engine` (`postgres` ou `mysql`).

## Configuration MySQL Hostinger

Dans les variables d’environnement de l’application Node.js Hostinger, utilisez soit une URL :

```env
DATABASE_URL=mysql://USER:PASSWORD@localhost:3306/DATABASE
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
APP_USERNAME=professeur
APP_PASSWORD=CHANGE_ME_WITH_A_LONG_RANDOM_PASSWORD
```

Soit, de préférence si le mot de passe contient des caractères spéciaux, les variables séparées :

```env
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=u000000000_user
DB_PASSWORD=CHANGE_ME
DB_NAME=u000000000_classia
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
```

Ne définissez pas simultanément `DATABASE_URL` et les variables `DB_*` : `DATABASE_URL` est prioritaire.

## Migrer PostgreSQL vers MySQL

La migration se lance depuis une machine autorisée à joindre les deux bases. Pour une base Hostinger distante, activez temporairement l’accès MySQL distant pour votre adresse IP dans hPanel.

```powershell
$env:SOURCE_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/classia_db"
$env:TARGET_DB_TYPE="mysql"
$env:TARGET_DB_HOST="HOST_MYSQL"
$env:TARGET_DB_PORT="3306"
$env:TARGET_DB_USER="USER"
$env:TARGET_DB_PASSWORD="PASSWORD"
$env:TARGET_DB_NAME="DATABASE"
npm run migrate:database
```

Le script crée le schéma cible avec les bons types MySQL, lit les données PostgreSQL puis les insère dans l’ordre des dépendances. Il refuse d’écraser une cible contenant déjà des classes. Pour autoriser volontairement un remplacement complet :

```powershell
$env:MIGRATION_REPLACE_EXISTING="true"
$env:MIGRATION_RESET_TARGET="true" # supprime et recrée le schéma cible incompatible
npm run migrate:database
```

Après la migration, supprimez ces variables temporaires de la session PowerShell :

```powershell
Remove-Item Env:SOURCE_DATABASE_URL, Env:TARGET_DB_TYPE, Env:TARGET_DB_HOST, Env:TARGET_DB_PORT, Env:TARGET_DB_USER, Env:TARGET_DB_PASSWORD, Env:TARGET_DB_NAME, Env:MIGRATION_REPLACE_EXISTING -ErrorAction SilentlyContinue
```

## Fonctionnalités principales

- Contrôles dynamiques et colonnes uniques Activités/Participation, renommables, réinitialisables, supprimables et réactivables.
- Formule de moyenne pondérée configurable par coefficients, avec ajout automatique des nouvelles colonnes.
- Tri réversible du carnet de notes et retour immédiat à l’ordre brut de l’import.
- Histogramme de distribution, moyenne, médiane, taux de réussite et étendue des résultats.
- Renommage, réinitialisation et suppression sécurisée des colonnes de contrôle.
- Séances à deux heures avec états brouillon et validé.
- Raccourcis pour marquer toute la classe, la première heure ou la deuxième heure présente.
- Assiduité par séance et suivi séparé des heures d'absence.
- Alertes d'absence, observations datées et points positifs ou négatifs.
- Observations générales ou multi-élèves avec recherche, suivi et suppression sécurisée.
- Numéro d’ordre modifiable et moyenne générale dans la liste des élèves.
- Dates affichées au format `jj/mm/aaaa` avec calendrier français intégré et navigation mensuelle.
- Identité Classia, icône de notification et thèmes clair/sombre persistants.
- Sauvegarde JSON depuis le panneau Paramètres.
