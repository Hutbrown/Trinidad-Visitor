// Netlify serverless function: secure Google Places proxy
// ---------------------------------------------------------------
// The Google API key lives ONLY here, in a Netlify environment
// variable (GOOGLE_PLACES_KEY) — never in the app's public code.
// The browser calls THIS function; this function calls Google.
//
// Setup (done once in the Netlify dashboard):
//   Site settings -> Environment variables -> add
//     Key:   GOOGLE_PLACES_KEY
//     Value: <your Google Places API key>
//
// The app calls:  /.netlify/functions/places?q=<search text>
// and gets back:  { results: [ { name, address, phone, hours,
//                                 website, category, lat, lng } ] }

exports.handler = async (event) => {
  const KEY = process.env.GOOGLE_PLACES_KEY;

  // CORS so the browser app can call this function
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (!KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: "Server is missing GOOGLE_PLACES_KEY. Add it in Netlify environment variables." }) };
  }

  const query = (event.queryStringParameters && event.queryStringParameters.q || "").trim();
  if (!query) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing search text." }) };
  }

  try {
    // 1) Text Search — find matching places, biased to the Trinidad CO area
    const searchUrl = "https://places.googleapis.com/v1/places:searchText";
    const searchResp = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        // Ask only for the fields we use (keeps cost down)
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.location",
          "places.nationalPhoneNumber",
          "places.websiteUri",
          "places.currentOpeningHours.weekdayDescriptions",
          "places.primaryTypeDisplayName",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: query,
        // Bias toward Trinidad, CO without hard-restricting (nearby towns OK)
        locationBias: {
          circle: {
            center: { latitude: 37.1695, longitude: -104.5005 },
            radius: 50000.0,
          },
        },
        maxResultCount: 3,
      }),
    });

    if (!searchResp.ok) {
      const t = await searchResp.text().catch(() => "");
      return { statusCode: 502, headers, body: JSON.stringify({
        error: `Google Places error ${searchResp.status}`, detail: t.slice(0, 300) }) };
    }

    const data = await searchResp.json();
    const places = Array.isArray(data.places) ? data.places : [];

    const results = places.map((p) => ({
      name: p.displayName?.text || "",
      address: p.formattedAddress || "",
      phone: p.nationalPhoneNumber || "",
      hours: (p.currentOpeningHours?.weekdayDescriptions || []).join("; "),
      website: p.websiteUri || "",
      category: p.primaryTypeDisplayName?.text || "",
      lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
      lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: "Lookup failed", detail: String(err).slice(0, 300) }) };
  }
};
