// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');

// Inicializace Firebase Admin SDK
// Zde z�st�v� glob�ln�, jak je obvykl�. Pokud by to st�le padalo, 
// posledn� mo�nost je p�esunout i toto do funkce (komplikovan�j�� pro Firestore db ref).
admin.initializeApp();
const db = admin.firestore();

// --- ZASADN� ZMENA: KONTROLA A NASTAVEN� API KL��E P�ESUNUTA DO FUNKCE ---
// NEBUDE SE NASTAVOVAT GLOB�LN�, ALE A� P�I PRVN�M VOL�N� FUNKCE.
// T�m se zajist�, �e potenci�ln� probl�my s kl��em nenastanou p�i startu kontejneru.
let sendGridApiKeyCache = null; // Bude uchov�vat kl�� po prvn�m na�ten�

// Cloud Function pro odes�l�n� email� s vy��tov�n�m
exports.sendBillingEmail = functions.https.onCall(async (data, context) => {
    // Inicializace SendGridu L�N� (LAZY INITIALIZATION) - a� p�i prvn�m vol�n�
    if (!sendGridApiKeyCache) {
        sendGridApiKeyCache = functions.config().sendgrid?.api_key;
        if (!sendGridApiKeyCache) {
            console.error('CRITICAL ERROR: SendGrid API key is not configured in Firebase Environment Variables.');
            console.error('Please run: firebase functions:config:set sendgrid.api_key="YOUR_SENDGRID_API_KEY"');
            throw new functions.https.HttpsError('failed-precondition', 'Serverov� konfigurace pro odes�l�n� e-mail� chyb�. Kontaktujte administr�tora.');
        }
        sgMail.setApiKey(sendGridApiKeyCache);
    }

    const { userId } = data;

    if (!userId) {
        throw new functions.https.HttpsError('invalid-argument', 'Chyb� ID u�ivatele.');
    }

    try {
        // 1. Na�ten� dat u�ivatele
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError('not-found', `U�ivatel s ID ${userId} nenalezen.`);
        }
        const userData = userDoc.data();
        const userName = userData.name;
        const userEmail = userData.email;

        // 2. Na�ten� aktivn� objedn�vky u�ivatele
        const ordersSnapshot = await db.collection('orders')
            .where('userId', '==', userId)
            .where('status', '==', 'active')
            .get();

        if (ordersSnapshot.empty) {
            return { success: false, message: `Pro u�ivatele ${userName} (${userEmail}) nejsou ��dn� aktivn� objedn�vky.` };
        }

        const order = ordersSnapshot.docs[0].data();
        let total = 0;
        let itemsHtml = '';

        // 3. Na�ten� v�ech produkt� pro zobrazen� n�zv� (na�ten� jednou, ne v cyklu)
        const productsSnapshot = await db.collection('products').get();
        const allProducts = {};
        productsSnapshot.forEach(doc => {
            allProducts[doc.id] = doc.data();
        });

        Object.entries(order.items).forEach(([productId, quantity]) => {
            const product = allProducts[productId];
            const productName = product ? product.name : `Nezn�m� produkt (ID: ${productId})`;
            const itemPrice = product ? product.price : 0;
            const itemTotal = itemPrice * quantity;
            total += itemTotal;

            itemsHtml += `
                <tr>
                    <td style="border: 1px solid #ddd; padding: 8px;">${productName}</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${quantity}x</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${itemPrice} K�</td>
                    <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${itemTotal} K�</td>
                </tr>
            `;
        });

        // 4. Generov�n� HTML obsahu emailu
        const bankAccountIBAN = 'CZ9203000000000219731465'; // P��klad IBAN
        const accountNumberFormatted = '219731465/0300'; // Pro zobrazen� v textu

        const msg = {
            to: userEmail,
            from: 'vladykosss@gmail.com', // **NAHRA�TE SV�M OV��EN�M E-MAILEM SENDGRIDU**
            subject: 'ADRIA GOLD - Shrnut� a platba objedn�vky',
            html: `
                <p>Ahoj,</p>
                <p>zde je shrnut� tv� aktu�ln� objedn�vky:</p>
                <table style="width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 20px; border: 1px solid #ddd;">
                    <thead>
                        <tr style="background-color: #f2f2f2;">
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Produkt</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: center;">Po�et</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Cena/ks</th>
                            <th style="border: 1px solid #ddd; padding: 8px; text-align: right;">Celkem</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                    <tfoot>
                        <tr style="font-weight: bold; background-color: #e6e6e6;">
                            <td colspan="3" style="border: 1px solid #ddd; padding: 8px; text-align: right;">Celkem k �hrad�:</td>
                            <td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${total} K�</td>
                        </tr>
                    </tfoot>
                </table>
                <p>Pro platbu pros�m pou�ij bankovn� p�evod na ��et: <strong>${accountNumberFormatted}</strong> (IBAN: ${bankAccountIBAN}) ve v��i <strong>${total} K�</strong>.</p>
                <p style="margin-top: 20px;">D�kujeme za objedn�vku!</p>
                <p>S pozdravem,<br>Luk� Vladyka</p>
            `
        };

        await sgMail.send(msg);

        return { success: true, message: `E-mail s vy��tov�n�m odesl�n u�ivateli ${userName} (${userEmail}).` };

    } catch (error) {
        console.error("Chyba p�i odes�l�n� e-mailu (Cloud Function):", error.response?.body || error);
        throw new functions.https.HttpsError('internal', 'Nepoda�ilo se odeslat e-mail s vy��tov�n�m.', error.message);
    }
});