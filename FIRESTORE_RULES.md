# Regole Firestore per BrickFeed

L'`apiKey` Firebase nel sorgente è pubblica per design: **le regole di sicurezza
Firestore sono l'unica vera barriera** sui dati. Da applicare nella console
Firebase (progetto `brickboy-b008e`) → Firestore Database → Rules.

## Modello dati

- `brickfeed/{uid}` — un solo documento per utente con fonti, notizie salvate,
  notizie manuali, ID delle notizie lette e impostazioni. Scritto e letto solo
  dal proprietario.

## Regola da aggiungere

Dentro il blocco `match /databases/{database}/documents { … }` già esistente
(insieme alle regole di HourFlow), aggiungere:

```
    // BrickFeed: dati personali dell'utente, barriera = uid.
    match /brickfeed/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
```

Dopo la modifica premere **Publish**. Nessun'altra configurazione è necessaria:
l'autenticazione email/password è già attiva nel progetto.
