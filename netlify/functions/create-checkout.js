// Fonction désactivée — paiement géré par PayPal côté client
exports.handler = async () => ({
  statusCode: 410,
  body: JSON.stringify({ error: "Cette fonction n'est plus utilisée." })
});
