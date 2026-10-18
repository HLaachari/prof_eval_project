# Classia

Application web de suivi pédagogique pour un professeur d’informatique. Les cinq classes et leurs élèves sont initialisés depuis les exports Excel fournis, puis enregistrés dans PostgreSQL.

## Lancer localement

1. Copier `.env.example` vers `.env` et renseigner `DATABASE_URL`.
2. Installer les dépendances et démarrer Classia depuis la racine du projet :

```powershell
npm install
npm start
```

Puis ouvrir `http://localhost:4173`.

Le serveur crée automatiquement la base cible si elle n’existe pas (avec un utilisateur PostgreSQL autorisé), initialise le schéma et sert l’API avec l’interface. La chaîne de connexion reste côté serveur dans `.env` et n’est jamais exposée au navigateur.

Les contrôles, notes, séances, présences, points et observations sont synchronisés dans PostgreSQL. Le stockage local du navigateur sert de sauvegarde hors ligne. Si la base est vide au premier démarrage, les données déjà présentes dans le navigateur sont importées automatiquement.

Vérification de la connexion :

```powershell
Invoke-RestMethod http://localhost:4173/api/health
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
