// ============================================================
// DATA Patrimonio — live chat assistant (POST /api/chat)
// Answers ONLY from a curated knowledge base built from the site's own
// approved copy (public/i18n.js: how-it-works, the two tracks, the quality
// gate, storage/insurance, the valuation disclaimer, the agreement draft).
// Anything outside the base gets a plain "I don't know" + a hand-off to
// WhatsApp / email. It never invents numbers, terms or promises:
// valuations are preliminary, there is no upfront payment and no
// guaranteed sale on the license track, and no deals have been closed yet.
// ============================================================

const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Each topic: keyword stems (matched against the normalized message in
// either language), then the answer in each language. Order matters:
// the first topic with a keyword hit wins, so specific topics come first.
const KB = [
  {
    topic: "deals_status",
    keys: ["han cerrado", "ya vendieron", "han vendido", "cuantos clientes", "cuantos tratos", "tratos cerrados", "deals closed", "have you closed", "have you sold", "how many clients", "success stories", "casos de exito"],
    en: "Honest answer: we are launching now and we have not closed any deals yet. That is exactly why every number on this page is labeled a preliminary estimate, and why payment only happens after the quality gate described in the agreement is complete.",
    es: "Respuesta honesta: estamos lanzando ahora y todavía no hemos cerrado ningún trato. Por eso cada número de esta página está marcado como estimado preliminar, y el pago solo se hace cuando se completa la puerta de calidad descrita en el acuerdo.",
  },
  {
    topic: "compra_directa",
    keys: ["compra directa", "compran", "direct purchase", "buy my data", "buy outright", "sell a copy", "vender una copia", "vendo una copia"],
    en: "Direct purchase: you sell us a copy of your data and you always keep your own copy. We receive full rights to the delivered copy, including the right to resell it, license it and use it to train AI models. Payment is one-time and is made only after your sample and full delivery pass verification against the signed manifest. The sale is final.",
    es: "Compra directa: nos vendes una copia de tus datos y tú siempre conservas tu propia copia. Nosotros recibimos todos los derechos sobre la copia entregada, incluidos revenderla, licenciarla y usarla para entrenar modelos de AI. El pago es único y se hace solo cuando tu muestra y la entrega completa pasan la verificación contra el manifiesto firmado. La venta es final.",
  },
  {
    topic: "licencia",
    keys: ["licencia", "license", "licence", "65%", "65 %", "sesenta y cinco"],
    en: "License: you stay the owner of your data. We license it to buyers on a non-exclusive basis, so the same data may be licensed to several buyers. You receive 65% and the Company 35% of each license sale, paid after the buyer approves your data. There is no upfront payment and no guaranteed sales.",
    es: "Licencia: tú sigues siendo el dueño de tus datos. Los licenciamos a compradores de forma no exclusiva: los mismos datos pueden licenciarse a varios compradores. Tú recibes el 65% y la Compañía el 35% de cada venta de licencia, pagado después de que el comprador apruebe tus datos. Sin pago por adelantado ni ventas garantizadas.",
  },
  {
    topic: "payment",
    keys: ["cuando pagan", "cuando me pagan", "cuando recibo", "when do i get paid", "when do you pay", "how do i get paid", "como me pagan", "pago por adelantado", "upfront"],
    en: "Payment timing: with Direct purchase, payment is released when your delivery is verified and approved. With a License, you are paid after each buyer approves your data. There is never an upfront payment before the quality gate is complete.",
    es: "Tiempos de pago: con Compra directa, el pago se libera cuando tu entrega está verificada y aprobada. Con Licencia, te pagamos después de que cada comprador apruebe tus datos. Nunca hay pago por adelantado antes de completar la puerta de calidad.",
  },
  {
    topic: "valuation",
    keys: ["cuanto vale", "cuanto valen", "cuanto pagan por", "valoracion", "valuacion", "estimado", "cuanto cuesta", "how much is", "how much are", "how much do you pay", "valuation", "estimate", "what is my data worth", "worth"],
    en: "The valuation on this page takes about 2 minutes: a base from your revenue band, adjusted by years of records, employees, record types, format and whether the data keeps growing. The result is a preliminary estimate only — the final price is confirmed once we verify your documentation and a sample of your data. Use the «Value my data» window to get your range.",
    es: "La valoración de esta página toma unos 2 minutos: una base por tu banda de ingresos, ajustada por años de registros, empleados, tipos de registro, formato y si los datos siguen creciendo. El resultado es solo un estimado preliminar: el precio final se confirma cuando verifiquemos tu documentación y una muestra de tus datos. Usa la ventana «Valúa tus datos» para obtener tu rango.",
  },
  {
    topic: "quality_gate",
    keys: ["verificacion", "verifican", "muestra", "puerta de calidad", "manifiesto", "verification", "verify", "sample", "quality gate", "manifest", "clawback", "devolucion"],
    en: "The quality gate: before any firm number, you sign a manifest declaring the data is yours and accurate. You then upload a small sample through a secure link and we compare it with the manifest — record count, format, fields, accuracy. If the sample does not match, there is no deal. If a defect is found after payment, the affected amount is returned.",
    es: "La puerta de calidad: antes de cualquier número firme, firmas un manifiesto declarando que los datos son tuyos y exactos. Luego subes una muestra pequeña por un enlace seguro y la comparamos con el manifiesto: conteo de registros, formato, campos, exactitud. Si la muestra no coincide, no hay trato. Si se encuentra un defecto después del pago, se devuelve el monto afectado.",
  },
  {
    topic: "security",
    keys: ["seguridad", "boveda", "vault", "seguro", "insurance", "donde guardan", "almacenamiento", "storage", "secure", "security", "offline", "fuera de linea"],
    en: "Security and storage: delivered data is stored in an offline vault with logged access. The Company carries the risk of loss while it holds the data and maintains insurance for it. Buyers never receive the master copy — viewing happens through separate, controlled copies under the terms you signed.",
    es: "Seguridad y almacenamiento: los datos entregados se guardan en una bóveda fuera de línea con acceso registrado. La Compañía carga con el riesgo de pérdida mientras tiene los datos y mantiene un seguro para ello. Los compradores nunca reciben la copia maestra: la revisión se hace con copias separadas y controladas, bajo las condiciones que firmaste.",
  },
  {
    topic: "privacy",
    keys: ["privacidad", "datos personales", "privacy", "personal data", "personal information", "seguro social", "social security", "tarjetas de mis clientes"],
    en: "Privacy: before delivery, you remove or flag your customers' personal identifiers (Social Security, card and bank numbers, health information). We remove any that remain before any sale or license.",
    es: "Privacidad: antes de entregar, tú quitas o marcas los identificadores personales de tus clientes (Seguro Social, números de tarjeta y de banco, información de salud). Nosotros eliminamos los que queden antes de cualquier venta o licencia.",
  },
  {
    topic: "keep_copy",
    keys: ["me quedo con", "mi copia", "pierdo mis datos", "keep my", "my own copy", "lose my data", "sigo usando", "keep using"],
    en: "You always keep your own copy of your data and may keep using it in your business. We only ever receive a copy.",
    es: "Tú siempre conservas tu propia copia de tus datos y puedes seguir usándola en tu negocio. Nosotros solo recibimos una copia.",
  },
  {
    topic: "how",
    keys: ["como funciona", "como es el proceso", "que pasos", "how does it work", "how it works", "what are the steps", "process", "como empiezo", "how do i start", "como empezar"],
    en: "How it works, in 6 steps: 1) You value your data in 2 minutes. 2) You sign a short, clear agreement. 3) You upload a sample through a secure link. 4) We verify the sample matches what you declared. 5) We pay you. 6) Your data is kept in a secure offline vault and offered to AI companies under the terms you signed.",
    es: "Cómo funciona, en 6 pasos: 1) Valoras tus datos en 2 minutos. 2) Firmas un acuerdo corto y claro. 3) Subes una muestra por un enlace seguro. 4) Verificamos que la muestra coincide con lo declarado. 5) Te pagamos. 6) Tus datos se guardan en una bóveda segura fuera de línea y se ofrecen a empresas de AI bajo las condiciones que firmaste.",
  },
  {
    topic: "buyers",
    keys: ["quien compra", "compradores", "empresas de ai", "who buys", "buyers", "ai companies", "para que usan", "what is it used for", "entrenar"],
    en: "AI companies need the real-world experience of companies like yours — invoices, quotes, contracts and emails from years of work — including to train artificial-intelligence models. That use is disclosed in the agreement before you sign, in plain language.",
    es: "Las empresas de AI necesitan la experiencia real de empresas como la tuya — facturas, cotizaciones, contratos y correos de años de trabajo — incluso para entrenar modelos de inteligencia artificial. Ese uso está divulgado en el acuerdo antes de que firmes, en lenguaje claro.",
  },
  {
    topic: "human",
    keys: ["hablar con alguien", "una persona", "humano", "telefono", "llamar", "talk to someone", "a person", "human", "phone", "call you", "whatsapp", "correo", "email"],
    en: "You can reach a person two ways, right from this chat: tap «Continue on WhatsApp» to message us, or «Send by email» and we will reply to your email. Both buttons are always at the bottom of this chat.",
    es: "Puedes llegar a una persona de dos formas, desde este mismo chat: toca «Seguir por WhatsApp» para escribirnos, o «Enviar por email» y te respondemos a tu correo. Ambos botones están siempre al final de este chat.",
  },
  {
    topic: "greeting",
    keys: ["hola", "buenas", "buenos dias", "buenas tardes", "hello", "hi", "hey", "good morning", "good afternoon"],
    en: "Hello! I can explain how DATA Patrimonio works: the two ways to sell (Direct purchase or License), how the valuation and the quality gate work, and how your data is stored. What would you like to know?",
    es: "¡Hola! Puedo explicarte cómo funciona DATA Patrimonio: las dos formas de vender (Compra directa o Licencia), cómo funciona la valoración y la puerta de calidad, y cómo se guardan tus datos. ¿Qué te gustaría saber?",
  },
];

const FALLBACK = {
  en: "I don't have an answer for that in what I can explain here, and I don't want to invent one. A person on our team can answer you: tap «Continue on WhatsApp» or «Send by email» below and we'll take it from there.",
  es: "No tengo una respuesta para eso dentro de lo que puedo explicar aquí, y no quiero inventar una. Una persona de nuestro equipo sí puede responderte: toca «Seguir por WhatsApp» o «Enviar por email» aquí abajo y lo seguimos por ahí.",
};

// answerChat(message, lang) → { topic, inScope, handoff, text }
function answerChat(message, lang) {
  const l = lang === "es" ? "es" : "en";
  const m = " " + norm(message) + " ";
  for (const item of KB) {
    if (item.keys.some(k => m.includes(norm(k)))) {
      return { topic: item.topic, inScope: true, handoff: false, text: item[l] };
    }
  }
  return { topic: "out_of_scope", inScope: false, handoff: true, text: FALLBACK[l] };
}

module.exports = { answerChat, KB };
