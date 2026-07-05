# Regole Firestore per BrickFeed

BrickFeed usa un progetto Firebase dedicato. L'`apiKey` nel sorgente è pubblica
per design: **le regole di sicurezza Firestore sono l'unica vera barriera** sui
dati. Da applicare nella console Firebase → Firestore Database → Rules.

## Modello dati

- `brickfeed/{uid}` — un solo documento per utente con fonti, notizie salvate,
  notizie manuali, ID delle notizie lette e impostazioni. Scritto e letto solo
  dal proprietario.

## Regole complete (sostituire tutto il contenuto)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // BrickFeed: dati personali dell'utente, barriera = uid.
    match /brickfeed/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Dopo la modifica premere **Publish**.
