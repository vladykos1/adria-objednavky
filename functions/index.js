// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

// Inicializace Firebase Admin SDK
// Zde zùstává globálnì, jak je obvyklé. Pokud by to stále padalo, 
// poslední možnost je pøesunout i toto do funkce (komplikovanìjší pro Firestore db ref).
admin.initializeApp();
const db = admin.firestore();

// --- ZASADNÍ ZMENA: KONTROLA A NASTAVENÍ API KLÍÈE PØESUNUTA DO FUNKCE ---
// NEBUDE SE NASTAVOVAT GLOBÁLNÌ, ALE AŽ PØI PRVNÍM VOLÁNÍ FUNKCE.
// Tím se zajistí, že potenciální problémy s klíèem nenastanou pøi startu kontejneru.
let sendGridApiKeyCache = null; // Bude uchovávat klíè po prvním naètení

// Cloud Function pro odesílání emailù s vyúètováním
exports.sendBillingEmail = functions.https.onCall(async (data, context) => {
    // Inicializace SendGridu LÍNÌ (LAZY INITIALIZATION) - až pøi prvním volání
    if (!sendGridApiKeyCache) {
        sendGridApiKeyCache = functions.config().sendgrid?.api_key;
        if (!sendGridApiKeyCache) {
            console.error('CRITICAL ERROR: SendGrid API key is not configured in Firebase Environment Variables.');
            console.error('Please run: firebase functions:config:set sendgrid.api_key="YOUR_SENDGRID_API_KEY"');
            throw new functions.https.HttpsError('failed-precondition', 'Serverová konfigurace pro odesílání e-mailù chybí. Kontaktujte administrátora.');
        }
        sgMail.setApiKey(sendGridApiKeyCache);
    }

    const { userId } = data;

    if (!userId) {
        throw new functions.https.HttpsError('invalid-argument', 'Chybí ID uživatele.');
    }

    try {
        // 1. Naètení dat uživatele
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError('not-found', `Uživatel s ID ${userId} nenalezen.`);
        }
        const userData = userDoc.data();
        const userName = userData.name;
        const userEmail = userData.email;

        // 2. Naètení aktivní objednávky uživatele
        const ordersSnapshot = await db.collection('orders')
            .where('userId', '==', userId)
            .where('status', '==', 'active')
            .get();

        if (ordersSnapshot.empty) {
            return { success: false, message: `Pro uživatele ${userName} (${userEmail}) nejsou žádné aktivní objednávky.` };
        }

        const order = ordersSnapshot.docs[0].data();
        let total = 0;
        let itemsHtml = '';

        // 3. Naètení všech produktù pro zobrazení názvù (naètení jednou, ne v cyklu)
        const productsSnapshot = await db.collection('products').get();
        const allProducts = {};
        productsSnapshot.forEach(doc => {
            allProducts[doc.id] = doc.data();
        });

        Object.entries(order.items).forEach(([productId, quantity]) => {
            const product = allProducts[productId];
            const productName = product ? product.name : `Neznámý produkt (ID: ${productId})`;
            const itemPrice = product ? product.price : 0;
            const itemTotal = itemPrice * quantity;
            total += itemTotal;

            itemsHtml += `
                <tr>
                    <td style="border: 1px solid #ddd; padding: 8px;">${productName}</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${quantity}x</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${itemPrice} Kè</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${itemTotal} Kè</td>
                </tr>
            `;
        });

        // 4. Generování HTML obsahu emailu
        const bankAccountIBAN = 'CZ9203000000000219731465'; // Pøíklad IBAN
        const accountNumberFormatted = '219731465/0300'; // Pro zobrazení v textu

        const msg = {
            to: userEmail,
            from: 'vladykosss@gmail.com', // **NAHRAÏTE SVÝM OVÌØENÝM E-MAILEM SENDGRIDU**
            subject: 'ADRIA GOLD - Shrnutí a platba objednávky',
            html: `
                <p>Ahoj,</p>
                <p>zde je shrnutí tvé aktuální objednávky:</p>
                <table style="width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 20px; border: 1px solid #ddd;">
                    <thead>
                        <tr style="background-color: #f2f2f2;">
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Produkt</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: center;">Poèet</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Cena/ks</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Celkem</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                    <tfoot>
                        <tr style="font-weight: bold; background-color: #e6e6e6;">
                            <td colspan="3" style="border: 1px solid #ddd; padding: 8px; text-align: right;">Celkem k úhradì:</td>
                            <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${total} Kè</td>
                        </tr>
                    </tfoot>
                </table>
                <p>Pro platbu prosím použij bankovní pøevod na úèet: <strong>${accountNumberFormatted}</strong> (IBAN: ${bankAccountIBAN}) ve výši <strong>${total} Kè</strong>.</p>
                <p style="margin-top: 20px;">Dìkujeme za objednávku!</p>
                <p>S pozdravem,<br>Lukáš Vladyka</p>
            `
        };

        await sgMail.send(msg);

        return { success: true, message: `E-mail s vyúètováním odeslán uživateli ${userName} (${userEmail}).` };

    } catch (error) {
        console.error("Chyba pøi odesílání e-mailu (Cloud Function):", error.response?.body || error);
        throw new functions.https.HttpsError('internal', 'Nepodaøilo se odeslat e-mail s vyúètováním.', error.message);
    }
});