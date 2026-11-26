/* DATA Patrimonio — every word on the site, in English and Spanish.
   O = answer options (codes are the engine's and the database's own keys)
   T = page text, AG = the draft agreement. Edit wording here only. */
const O={
 sector:[["gc","General construction","Construcción general","t"],["stucco","Stucco","Stucco","t"],["paint","Painting","Pintura","t"],["roof","Roofing","Roofing","t"],["elec","Electrical","Electricidad","t"],["plumb","Plumbing","Plomería","t"],["hvac","HVAC","HVAC","t"],["remodel","Remodeling","Remodelación","t"],["realestate","Real-estate development","Desarrollo inmobiliario","o"],["mfg","Manufacturing","Manufactura","o"],["transport","Transport & logistics","Transporte y logística","o"],["health","Health","Salud","o"],["legal","Legal","Legal","o"],["accounting","Accounting","Contabilidad","o"],["restaurant","Restaurants","Restaurantes","o"],["retail","Retail","Comercio y tiendas","o"],["services","Professional services","Servicios profesionales","o"],["tech","Technology","Tecnología","o"],["agri","Agriculture","Agricultura","o"],["other","Other","Otro","o"]],
 years:[["under3","Less than 3","Menos de 3"],["3to5","3–5","3–5"],["5to10","5–10","5–10"],["over10","More than 10","Más de 10"]],
 emp:[["1to10","1–10","1–10"],["11to25","11–25","11–25"],["26to50","26–50","26–50"],["51to75","51–75","51–75"],["over75","More than 75","Más de 75"]],
 types:[["invoices","Invoices","Facturas"],["quotes","Quotes","Cotizaciones"],["contracts","Contracts","Contratos"],["drawings","Drawings / plans","Planos"],["email","Emails","Correos"],["photos","Photos","Fotos"],["accounting","Accounting","Contabilidad"]],
 vol:[["under1k","Under 1,000","Menos de 1,000"],["1kto10k","1,000 – 10,000","1,000 a 10,000"],["10kto50k","10,000 – 50,000","10,000 a 50,000"],["over50k","More than 50,000","Más de 50,000"]],
 rev:[["under2m","Under $2M","Menos de $2M"],["2to5m","$2M – $5M","$2M – $5M"],["5to10m","$5M – $10M","$5M – $10M"],["10to20m","$10M – $20M","$10M – $20M"],["over20m","Over $20M","Más de $20M"]],
 fmt:[["digital_structured","Structured digital","Digital estructurado"],["mixed","Mixed","Mixto"],["paper_scans","Paper or scanned","Papel o escaneado"]],
 freq:[["ongoing","Yes, it keeps growing","Sí, sigue creciendo"],["static","No, it's historical","No, es histórico"]],
 track:[["compra_directa","Direct purchase with exclusivity","Compra directa con exclusividad"],["licencia","License","Licencia"]],
 tier:[["Bronce","Bronze","Bronce"],["Plata","Silver","Plata"],["Oro","Gold","Oro"],["Platino","Platinum","Platino"]],
 status:[["Nuevo","New","Nuevo"],["Contactado","Contacted","Contactado"],["Papel enviado","Paper sent","Papel enviado"],["Firmado","Signed","Firmado"],["Muestra recibida","Sample received","Muestra recibida"],["Verificado","Verified","Verificado"],["Pagado","Paid","Pagado"],["En el vault","In the vault","En el vault"]],
 bkstatus:[["pending","Pending","Pendiente"],["confirmed","Confirmed","Confirmada"],["done","Done","Completada"]],
 bkzoom:[["none","Not created","Sin crear"],["queued","Queued","En cola"],["created","Created","Creado"],["failed","Failed","Falló"]]
};
const T={
en:{tag:"Your data is your legacy",heroT:"Your data is your legacy.",heroP:"AI companies need the real-world experience of companies like yours. Your invoices, quotes, contracts and emails from years of work are worth money. Find out how much in 2 minutes.",cta:"Value my data →",trust:"No commitment. Your information stays private and secure.",soundOff:"Listen to music",soundOn:"Music on",heroChip:"Years of work, turned into value",
 steps:["Your company","Your data","Size & format","Your valuation","Book your appointment","Agreement & signature","Done"],stepOf:(i,n)=>`Step ${i} of ${n}`,
 subs:["Tell us about your business.","What records do you keep, and for how many years?","Last questions before your valuation.","This is what your data could be worth.","Pick a day and a time window — we call you to go over your valuation.","Two pages. No hidden fine print.","You're in."],
 back:"Back",next:"Continue",see:"See my valuation",toContract:"Continue to agreement",submit:"Sign and submit",
 qSector:"Sector",gT:"Construction & trades",gO:"Every other industry",qBiz:"Years in business",qEmp:"Employees",qRec:"Years of records",qTypes:"Record types (choose all you have)",qVol:"Approximate number of records",
 qRev:"Annual revenue",qFmt:"Data format",qFreq:"Does the data keep growing?",qTrack:"How we buy your data",
 trackD:{compra_directa:"We buy your data and acquire the rights exclusively; you keep your own copy. One-time payment once your sample and delivery pass verification. We can resell and license the data."},
 rangeL:"Estimated value of your data",tierL:"Your data tier",scoreL:"Data score",built:"How we calculated your number",
 fl:{base:"Base from annual revenue",fYears:"Years of records",fEmployees:"Employees",fTypes:"Record types",fFormat:"Format",fFrequency:"Keeps growing"},pointL:"Point estimate",
 typesN:n=>`${n} type${n===1?"":"s"}`,
 disc:"Preliminary estimate. The final price is confirmed once we verify your documentation and a sample of your data.",
 buyNote:"Direct purchase with exclusivity: payment is made only after your sample and delivery pass verification.",
 intro:"This is the complete agreement: two pages, with every condition in plain view. By signing you accept the exclusive direct purchase (transfer of rights), you confirm the data is yours and correct, and you understand your data may be resold and used to train artificial-intelligence systems. The sale is final. (Draft text, subject to final legal review.)",
 fCo:"Company name",fOwner:"Owner name",fEmail:"Email",fPhone:"Phone",agT:"Agreement",manT:"Data manifest: confirm each item",
 man:["I own this data or have the legal right to sell it.","The data is accurate and matches what I described in this form.","I will remove or flag customers' personal details (Social Security, card and bank numbers, health information) before delivery.","I keep my own copy of the data.","My sample and full delivery will match this manifest. If they don't, there is no deal."],
 sigL:"Signature — click to choose your signature",dateL:"Date",
 sigClick:"Click here to sign",sigHint:"Pick a typed signature style or draw your own with your finger or mouse.",sigChosen:"Signature chosen — click to change it",sigModalT:"Choose how your signature should look",sigTabType:"Type",sigTabDraw:"Draw",sigPrompt:"Type your full name and pick a style:",sigPh:"Your full name",sigDrawPrompt:"Draw your signature in the box with your finger or mouse:",sigClear:"Clear",sigCancel:"Cancel",sigUse:"Use this signature",sigDrawEmpty:"Draw your signature in the box first.",sigStyles:"Signature styles",
 errSigMatch:"The typed signature must match the representative's name.",errSigMissing:"Click the signature box and pick or draw your signature to continue.",errEmailTld:"That email ending is not a real domain — for example, .jet is not valid. Did you mean .com? Check the ending (.com, .net, .org…).",errEmailFmt:"That email is not in a valid format. It should look like name@company.com, with no spaces.",
 e1:"Choose all three to continue.",e2:"Choose the years, at least one type, and the volume.",e3:"Choose all three to continue.",e5:"Fill in company, owner and an email or phone, check every manifest item, and sign in the signature window.",eSave:"We couldn't save right now. Please try again.",
 doneH:(n,f)=>`Done, ${n}! Your folio is ${f}.`,
 doneP:"Next step: we contact you to ask for a small sample of your data. If the sample confirms what you declared, we close at the confirmed price and pay you from our company in the United States.",
 upT:"Upload your sample here (optional for now)",drop:"Drag files here or tap to choose",dropS:"Excel, CSV, PDF, photos. Up to 10 files, 20 MB each.",upOk:"Attached to your folio",upLocal:"Recorded by name only (uploads are off in this view).",upFail:"Upload failed",again:"Start a new valuation",
 fbT:"Something you don't like? Tell us",fbPh:"Your comment…",fbSend:"Send comment",fbOk:"Thanks. Your comment was saved and our team will review it.",
 howT:"How it works inside",
 how:["You value your data in 2 minutes.","You sign a short, clear agreement.","You upload a sample through a secure link.","We verify the sample matches what you declared.","We pay you.","Your data is kept in a secure offline vault and offered to AI companies under the terms you signed."],
 mkT:"What the market really pays",mkS:"Research from November 2026. We show what is documented, what is inferred, and what can't be verified.",
 dealsT:"Documented deals",dealsTag:"Provider-reported and anonymized; all perpetual-exclusive. HVAC figure press-reported.",
 deals:[["Roofing",450000],["General contractor",300000],["Solar",275000],["HVAC (approx.)",150000],["Marketing agency",110000]],
 bandsT:"Price bands",bandsTag:"Our inference from the documented deals, not published prices.",bands:[["Small firms",25000,110000],["Medium firms",110000,300000],["Large SMB",275000,450000]],
 advT:"Advertised vs documented",adv:["Several AI-data programs (micro1, Mercor, Handshake, Mode, Scale and others) advertise $100K–$5M. We found no seller-confirmed payment to a small business at those levels.","Data marketplaces keep 15–30% of each sale. One well-known program publicizes a 50/50 split, but that is a referral-partner split; the data owner's share is not published.","Our 65% to the owner is stated in writing before intake.","We found no competitor marketing in Spanish to Hispanic business owners."],
 cantT:"What can't be verified",cantP:"No seller-confirmed payment exists in public sources for any of the big programs. Treat advertised figures as marketing until a seller confirms them.",
 foot:"DATA Patrimonio is a trade name of Data Is Money LLC. Valuations on this page are preliminary estimates subject to sample and documentation verification; no payment is made before the quality gate described in the agreement is complete.",
 adT:"Team panel",adSub:"Submissions, statuses and feedback, live.",tabSubs:"Submissions",tabFb:"Feedback",tabHow:"How it works inside",tabEng:"Engine & validation",
 cols:["Folio","Date","Company","Sector","Track","Estimate","Tier","Score","Status","Contact","Sample"],fcols:["Date","Step","Folio","Comment"],
 k1:"Submissions",k2:"Pipeline (high end)",k3:"Waiting on contact",k4:"Feedback",empty:"Nothing yet. Submissions appear here the moment a seller signs.",fEmpty:"No feedback yet.",
 exCsv:"Download CSV",exJson:"Download JSON",exCopy:"Copy JSON",copied:"Copied",
 noAccess:"The team panel is for editors of this page only.",localOnly:"Shared storage isn't available in this view, so this shows only submissions made in this browser.",
 pipeT:"The pipeline, step by step",
 pipe:[["Automatic valuation","Answers go into the engine: a base from the revenue band, times years of records, employees, record types, format and whether the data keeps growing. Out come the range, the tier (Bronze to Platinum) and a 0–100 score."],["Signed manifest","Before any firm number, the seller declares in writing that the data is theirs and accurate. That manifest is the legal base for everything else."],["Sample and verification","The seller uploads a sample. The team compares it with the manifest: record count, format, fields, accuracy. If it doesn't match, there's no deal. That is the quality gate."],["Agreement and DocuSign","Two pages, plain language, every disclosure. Signed here; the formal envelope goes out by DocuSign for the executed copy."],["Delivery and vault","The full data comes in through a secure upload link and goes to an offline vault with logged access. The company carries the risk, backed by insurance."],["Payment and sales","Direct purchase: payment released when delivery is approved. License: data offered to multiple buyers, the owner receives 65% of each approved sale."]],
 engT:"Engine settings (02-valuation-engine.js)",valT:"Validation profiles from the build kit",vcols:["Profile","Inputs","Point","Range","Tier","Score","Kit expects","Result"],pass:"Pass",miss:"Misses",
 valNote:"Constants were not changed to force a pass, as the kit instructs. Profile A has no record types named, so it is run with the 3 lowest-weight types and with 3 including email and accounting. Profile D asks for $20–50M revenue; the engine has one band for everything over $20M.",backFunnel:"Back to the seller funnel",stepWord:"Step",resultWord:"Done screen"},
es:{tag:"Tus datos son patrimonio",heroT:"Tus datos son patrimonio.",heroP:"Las empresas de AI necesitan la experiencia real de empresas como la tuya. Tus facturas, cotizaciones, contratos y correos de años de trabajo valen dinero. Descubre cuánto en 2 minutos.",cta:"Valorar mis datos →",trust:"Sin compromiso. Tu información se mantiene privada y segura.",soundOff:"Escuchar música",soundOn:"Música activada",heroChip:"Años de trabajo, convertidos en valor",
 steps:["Tu empresa","Tus datos","Tamaño y formato","Tu valoración","Reserva tu cita","Contrato y firma","Listo"],stepOf:(i,n)=>`Paso ${i} de ${n}`,
 subs:["Cuéntanos de tu negocio.","¿Qué registros guardas y de cuántos años?","Últimas preguntas antes de tu valoración.","Esto es lo que podrían valer tus datos.","Elige un día y un horario — te llamamos para hablar de tu valoración.","Dos páginas. Sin letra pequeña escondida.","Ya estás dentro."],
 back:"Atrás",next:"Continuar",see:"Ver mi valoración",toContract:"Continuar al contrato",submit:"Firmar y enviar",
 qSector:"Sector",gT:"Construcción y oficios",gO:"Todas las demás industrias",qBiz:"Años en el negocio",qEmp:"Empleados",qRec:"Años de registros",qTypes:"Tipos de registro (elige todos los que tengas)",qVol:"Volumen aproximado de registros",
 qRev:"Ingresos anuales",qFmt:"Formato de los datos",qFreq:"¿Los datos siguen creciendo?",qTrack:"Cómo compramos tus datos",
 trackD:{compra_directa:"Compramos tus datos y adquirimos los derechos en exclusiva; tú conservas tu copia. Pago único cuando tu muestra y la entrega pasan la verificación. Nosotros podemos revenderlos y licenciarlos."},
 rangeL:"Valor estimado de tus datos",tierL:"Nivel de tus datos",scoreL:"Puntuación de datos",built:"Así calculamos tu número",
 fl:{base:"Base por ingresos anuales",fYears:"Años de registros",fEmployees:"Empleados",fTypes:"Tipos de registro",fFormat:"Formato",fFrequency:"Siguen creciendo"},pointL:"Estimado puntual",
 typesN:n=>`${n} tipo${n===1?"":"s"}`,
 disc:"Estimado preliminar. El precio final se confirma cuando verifiquemos tu documentación y una muestra de tus datos.",
 buyNote:"Compra directa con exclusividad: el pago se hace solo cuando tu muestra y la entrega pasan la verificación.",
 intro:"Este es el acuerdo completo: dos páginas, con todas las condiciones a la vista. Al firmar aceptas la compra directa con exclusividad (transferencia de derechos), confirmas que los datos son tuyos y que son correctos, y entiendes que tus datos podrán ser revendidos y usados para entrenar sistemas de inteligencia artificial. La venta es final. (Texto borrador — sujeto a revisión legal final.)",
 fCo:"Nombre de la empresa",fOwner:"Nombre del dueño",fEmail:"Correo electrónico",fPhone:"Teléfono",agT:"Acuerdo",manT:"Manifiesto de datos: confirma cada punto",
 man:["Soy dueño de estos datos o tengo el derecho legal de venderlos.","Los datos son exactos y coinciden con lo que describí en este formulario.","Quitaré o marcaré los datos personales de mis clientes (Seguro Social, números de tarjeta y de banco, información de salud) antes de entregar.","Me quedo con mi propia copia de los datos.","Mi muestra y la entrega completa coincidirán con este manifiesto. Si no coinciden, no hay trato."],
 sigL:"Firma — haz clic para elegir tu firma",dateL:"Fecha",
 sigClick:"Haz clic aquí para firmar",sigHint:"Elige un estilo de firma escrita o dibuja la tuya con el dedo o el mouse.",sigChosen:"Firma elegida — haz clic para cambiarla",sigModalT:"Elige cómo quieres que se vea tu firma",sigTabType:"Escribir",sigTabDraw:"Dibujar",sigPrompt:"Escribe tu nombre completo y elige un estilo:",sigPh:"Tu nombre completo",sigDrawPrompt:"Dibuja tu firma en el recuadro con el dedo o el mouse:",sigClear:"Borrar",sigCancel:"Cancelar",sigUse:"Usar esta firma",sigDrawEmpty:"Primero dibuja tu firma en el recuadro.",sigStyles:"Estilos de firma",
 errSigMatch:"La firma escrita debe coincidir con el nombre del representante.",errSigMissing:"Haz clic en el recuadro de firma y elige o dibuja tu firma para continuar.",errEmailTld:"La terminación de ese correo no es un dominio real — por ejemplo, .jet no es válido. ¿Quisiste decir .com? Revisa la terminación (.com, .net, .org…).",errEmailFmt:"Ese correo no tiene un formato válido. Debe ser como nombre@empresa.com, sin espacios.",
 e1:"Elige las tres opciones para continuar.",e2:"Elige los años, al menos un tipo y el volumen.",e3:"Elige las tres opciones para continuar.",e5:"Completa empresa, dueño y un correo o teléfono, marca cada punto del manifiesto y firma en la ventana de firma.",eSave:"No pudimos guardar ahora. Intenta de nuevo.",
 doneH:(n,f)=>`¡Listo, ${n}! Tu folio es ${f}.`,
 doneP:"El siguiente paso: te contactamos para pedirte una muestra pequeña de tus datos. Si la muestra confirma lo que declaraste, cerramos al precio confirmado y te pagamos desde nuestra empresa en Estados Unidos.",
 upT:"Sube tu muestra aquí (opcional por ahora)",drop:"Arrastra archivos aquí o toca para escoger",dropS:"Excel, CSV, PDF, fotos. Hasta 10 archivos de 20 MB.",upOk:"Adjunto a tu folio",upLocal:"Registrado solo por nombre (la carga está apagada en esta vista).",upFail:"Falló la carga",again:"Empezar una nueva valoración",
 fbT:"¿Algo no te gusta? Cuéntanos",fbPh:"Tu comentario…",fbSend:"Enviar comentario",fbOk:"Gracias. Tu comentario quedó guardado y lo revisa nuestro equipo.",
 howT:"Cómo funciona por dentro",
 how:["Valoras tus datos en 2 minutos.","Firmas un acuerdo corto y claro.","Subes una muestra por un enlace seguro.","Verificamos que la muestra coincide con lo declarado.","Te pagamos.","Tus datos se guardan en una bóveda segura fuera de línea y se ofrecen a empresas de AI bajo las condiciones que firmaste."],
 mkT:"Lo que el mercado realmente paga",mkS:"Investigación de noviembre de 2026. Mostramos lo documentado, lo inferido y lo que no se puede verificar.",
 dealsT:"Tratos documentados",dealsTag:"Reportados por el proveedor y anonimizados; todos perpetuos y exclusivos. La cifra de HVAC viene de prensa.",
 deals:[["Roofing",450000],["Contratista general",300000],["Solar",275000],["HVAC (aprox.)",150000],["Agencia de marketing",110000]],
 bandsT:"Bandas de precio",bandsTag:"Nuestra inferencia a partir de los tratos documentados, no precios publicados.",bands:[["Empresas pequeñas",25000,110000],["Empresas medianas",110000,300000],["PyME grande",275000,450000]],
 advT:"Lo anunciado vs. lo documentado",adv:["Varios programas de datos para AI (micro1, Mercor, Handshake, Mode, Scale y otros) anuncian de $100K a $5M. No encontramos ningún pago confirmado por un vendedor pequeño a esos niveles.","Los mercados de datos se quedan con 15–30% de cada venta. Un programa conocido publicita un reparto 50/50, pero es el reparto de un socio referidor; la parte del dueño de los datos no se publica.","Nuestro 65% para el dueño se pone por escrito antes de recibir los datos.","No encontramos ningún competidor que se anuncie en español a dueños de negocios hispanos."],
 cantT:"Lo que no se puede verificar",cantP:"En fuentes públicas no existe ningún pago confirmado por un vendedor en ninguno de los programas grandes. Las cifras anunciadas son publicidad hasta que un vendedor las confirme.",
 foot:"DATA Patrimonio es la marca comercial de Data Is Money LLC. Las valoraciones de esta página son estimaciones preliminares sujetas a verificación de muestra y documentación; ningún pago se realiza antes de completar la puerta de calidad descrita en el acuerdo.",
 adT:"Panel del equipo",adSub:"Solicitudes, estados y comentarios, en vivo.",tabSubs:"Solicitudes",tabFb:"Comentarios",tabHow:"Cómo funciona por dentro",tabEng:"Motor y validación",
 cols:["Folio","Fecha","Empresa","Sector","Modalidad","Estimado","Nivel","Puntaje","Estado","Contacto","Muestra"],fcols:["Fecha","Paso","Folio","Comentario"],
 k1:"Solicitudes",k2:"En proceso (tope)",k3:"Esperando contacto",k4:"Comentarios",empty:"Nada todavía. Las solicitudes aparecen aquí en cuanto un vendedor firma.",fEmpty:"Sin comentarios todavía.",
 exCsv:"Descargar CSV",exJson:"Descargar JSON",exCopy:"Copiar JSON",copied:"Copiado",
 noAccess:"El panel del equipo es solo para editores de esta página.",localOnly:"El almacenamiento compartido no está disponible en esta vista; solo se ven las solicitudes hechas en este navegador.",
 pipeT:"El proceso, paso a paso",
 pipe:[["Valoración automática","Las respuestas entran al motor: una base por banda de ingresos, por años de registros, empleados, tipos de registro, formato y si los datos siguen creciendo. Salen el rango, el nivel (Bronce a Platino) y una puntuación de 0 a 100."],["Manifiesto firmado","Antes de cualquier número firme, el vendedor declara por escrito que los datos son suyos y exactos. Ese manifiesto es la base legal de todo lo demás."],["Muestra y verificación","El vendedor sube una muestra. El equipo la compara con el manifiesto: conteo de registros, formato, campos, exactitud. Si no coincide, no hay trato: esa es la puerta de calidad."],["Acuerdo y DocuSign","Dos páginas, lenguaje claro, todas las divulgaciones. Se firma aquí; el sobre formal sale por DocuSign para la copia ejecutada."],["Entrega y bóveda","Los datos completos entran por un enlace seguro y van a una bóveda fuera de línea con acceso registrado. La compañía carga con el riesgo, respaldada por seguro."],["Pago y ventas","Compra directa: el pago se libera al aprobarse la entrega. Licencia: los datos se ofrecen a varios compradores y el dueño recibe el 65% de cada venta aprobada."]],
 engT:"Configuración del motor (02-valuation-engine.js)",valT:"Perfiles de validación del kit",vcols:["Perfil","Datos","Puntual","Rango","Nivel","Puntaje","El kit espera","Resultado"],pass:"Pasa",miss:"No pasa",
 valNote:"No se cambiaron las constantes para forzar que pase, como pide el kit. El perfil A no dice qué tipos de registro; se corre con los 3 de menor peso y con 3 que incluyen correos y contabilidad. El perfil D pide ingresos de $20–50M; el motor tiene una sola banda para todo lo que pasa de $20M.",backFunnel:"Volver al formulario",stepWord:"Paso",resultWord:"Pantalla final"}
};

const AG={
en:[["","Parties and purpose","Data Is Money LLC, doing business as DATA Patrimonio (\"the Company\"), buys historical business data from the seller identified in this form (\"the Seller\") in an exclusive direct purchase, for resale and licensing, including to companies that train artificial-intelligence models."],
 ["","Seller keeps a copy","The Company receives a copy. The Seller always keeps its own copy and may keep using it in its business."],
 ["compra_directa","Direct purchase with exclusivity","The Seller transfers all rights to the delivered copy, exclusively, including the right to resell it, license it and use it to train AI models. Payment is one-time, made on verification. The sale is final. The Seller releases the Company from later claims over the sold copy."],
 ["","Quality gate and clawback","Every price is preliminary until a sample and the full delivery are verified against the signed manifest. If the data does not match, the Company may decline the deal. If a defect is found after payment, the Seller returns the affected amount."],
 ["","Privacy","The Seller removes or flags customers' personal identifiers before delivery. The Company removes any that remain before any sale."],
 ["","Storage and insurance","Delivered data is stored in an offline vault with logged access. The Company carries the risk of loss while it holds the data and maintains insurance for it."],
 ["","Signature","Signing here records the Seller's intent and the manifest. The executed agreement is delivered by DocuSign. This text is a draft until counsel approves the final paper."]],
es:[["","Partes y objeto","Data Is Money LLC, operando como DATA Patrimonio (\"la Compañía\"), compra datos comerciales históricos del vendedor identificado en este formulario (\"el Vendedor\") en una compra directa con exclusividad, para revenderlos y licenciarlos, incluso a compañías que entrenan modelos de inteligencia artificial."],
 ["","El Vendedor conserva una copia","La Compañía recibe una copia. El Vendedor siempre conserva su propia copia y puede seguir usándola en su negocio."],
 ["compra_directa","Compra directa con exclusividad","El Vendedor transfiere todos los derechos sobre la copia entregada, en exclusiva, incluidos el derecho de revenderla, licenciarla y usarla para entrenar modelos de AI. El pago es único, al verificar. La venta es final. El Vendedor libera a la Compañía de reclamaciones posteriores sobre la copia vendida."],
 ["","Puerta de calidad y devolución","Todo precio es preliminar hasta verificar una muestra y la entrega completa contra el manifiesto firmado. Si los datos no coinciden, la Compañía puede rechazar el trato. Si se encuentra un defecto después del pago, el Vendedor devuelve el monto afectado."],
 ["","Privacidad","El Vendedor quita o marca los identificadores personales de sus clientes antes de entregar. La Compañía elimina los que queden antes de cualquier venta."],
 ["","Almacenamiento y seguro","Los datos entregados se guardan en una bóveda fuera de línea con acceso registrado. La Compañía carga con el riesgo de pérdida mientras tiene los datos y mantiene un seguro para ello."],
 ["","Firma","Firmar aquí registra la intención del Vendedor y el manifiesto. El acuerdo ejecutado se entrega por DocuSign. Este texto es un borrador hasta que un abogado apruebe el documento final."]]
};


/* team-panel sign-in and server messages */
Object.assign(T.en,{loginT:"Team sign-in",loginS:"Enter the team password to see submissions and feedback.",pw:"Password",signIn:"Sign in",badPw:"Wrong password, or too many tries. Wait a minute and try again.",logout:"Sign out",netErr:"Can't reach the server. Check your connection and try again.",upToken:"This upload link has expired. Contact us and we'll send a new one."});
Object.assign(T.es,{loginT:"Acceso del equipo",loginS:"Escribe la contraseña del equipo para ver solicitudes y comentarios.",pw:"Contraseña",signIn:"Entrar",badPw:"Contraseña incorrecta o demasiados intentos. Espera un minuto y vuelve a intentar.",logout:"Salir",netErr:"No podemos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",upToken:"Este enlace de carga venció. Contáctanos y te enviamos uno nuevo."});

/* soft launch (Nov 24 2026): top navigation windows, prominent comment
   button, Security/Vault + FAQ + Contact windows, live chat widget */
Object.assign(T.en,{
 nav:{inicio:"Home",como:"How it works",valua:"Value my data",seguridad:"Security & Vault",preguntas:"FAQ",contacto:"Contact"},
 fbNav:"Leave us a comment",fbModalT:"Tell us what you think",fbModalS:"What don't you like? What should we change? Anything you want to tell us goes straight to our team.",
 secT:"Security & the Vault",secS:"How your data is protected, from upload to storage.",
 sec:[["Offline vault","Delivered data is stored in an offline vault with logged access. The master copy is never shown to buyers."],["Separate viewing copies","Buyers review a separate, controlled copy — never the master — under the terms you signed."],["Quality gate first","Nothing is stored for sale until your sample and delivery are verified against the signed manifest."],["Insurance","The Company carries the risk of loss while it holds the data and maintains insurance for it."],["Privacy removed first","You remove or flag customers' personal identifiers before delivery; we remove any that remain before any sale or license."]],
 faqT:"Frequently asked questions",
 faq:[["How does it work?","You value your data in 2 minutes, sign a short agreement, upload a sample through a secure link, we verify it matches what you declared, and we pay you."],
 ["What is the difference between Direct purchase and License?","Direct purchase: you sell us a copy, keep yours, and get a one-time payment on verification; we can resell and license the copy. License: you stay the owner and receive 65% of each approved license sale, paid after the buyer approves your data."],
 ["When do I get paid?","Direct purchase: when your delivery is verified and approved. License: after each buyer approves your data. There is no upfront payment before the quality gate is complete, and license sales are not guaranteed."],
 ["Is the valuation final?","No. Every valuation here is a preliminary estimate. The final price is confirmed once we verify your documentation and a sample of your data."],
 ["What if my sample doesn't match what I declared?","Then there is no deal. That verification is the quality gate, and it protects both sides."],
 ["Do I keep my data?","Yes. You always keep your own copy and may keep using it in your business. We only receive a copy."],
 ["Have you closed deals yet?","Not yet — we are launching now. That is why every number on this page is labeled a preliminary estimate, and why payment only happens after the quality gate is complete."]],
 conT:"Contact",conS:"Talk to a person on our team.",conWa:"Message us on WhatsApp",conWaMsg:"Hello, I have a question about DATA Patrimonio.",
 conFormT:"Send us an email message",fName:"Your name (optional)",fMsg:"Your message",conSend:"Send message",conOk:"Thanks — your message was saved and our team will reply to your email.",chatNote:"Faster: the chat button at the bottom right answers the most common questions right away.",
 chatT:"Chat with us",chatOpen:"Chat with us",chatHello:"Hello! I can explain how DATA Patrimonio works — the two ways to sell, the valuation, the quality gate and the vault. What would you like to know?",chatPh:"Write your question…",chatSend:"Send",chatWa:"Continue on WhatsApp",chatEmail:"Send by email",chatEmailT:"Send your question by email and we'll reply to you.",chatSent:"Sent. Our team will reply to your email.",
 tabChats:"Chats",tabContact:"Messages",chatCols:["Session","Date","Language","Conversation"],contactCols:["Date","Name","Email","Track","Message"],chatEmpty:"No chats yet.",contactEmpty:"No email messages yet.",generalWord:"General"
});
Object.assign(T.es,{
 nav:{inicio:"Inicio",como:"Cómo funciona",valua:"Valúa tus datos",seguridad:"Seguridad y bóveda",preguntas:"Preguntas",contacto:"Contacto"},
 fbNav:"Déjanos tu comentario",fbModalT:"Cuéntanos qué piensas",fbModalS:"¿Qué no te gusta? ¿Qué deberíamos cambiar? Todo lo que nos digas llega directo a nuestro equipo.",
 secT:"Seguridad y la bóveda",secS:"Cómo se protegen tus datos, desde la carga hasta el almacenamiento.",
 sec:[["Bóveda fuera de línea","Los datos entregados se guardan en una bóveda fuera de línea con acceso registrado. La copia maestra nunca se muestra a los compradores."],["Copias de revisión separadas","Los compradores revisan una copia separada y controlada — nunca la maestra — bajo las condiciones que firmaste."],["Primero la puerta de calidad","Nada se almacena para la venta hasta verificar tu muestra y tu entrega contra el manifiesto firmado."],["Seguro","La Compañía carga con el riesgo de pérdida mientras tiene los datos y mantiene un seguro para ello."],["Privacidad eliminada primero","Tú quitas o marcas los identificadores personales de tus clientes antes de entregar; nosotros eliminamos los que queden antes de cualquier venta o licencia."]],
 faqT:"Preguntas frecuentes",
 faq:[["¿Cómo funciona?","Valoras tus datos en 2 minutos, firmas un acuerdo corto, subes una muestra por un enlace seguro, verificamos que coincide con lo declarado y te pagamos."],
 ["¿Cuál es la diferencia entre Compra directa y Licencia?","Compra directa: nos vendes una copia, conservas la tuya y recibes un pago único al verificar; nosotros podemos revender y licenciar la copia. Licencia: tú sigues siendo el dueño y recibes el 65% de cada venta de licencia aprobada, pagado después de que el comprador apruebe tus datos."],
 ["¿Cuándo me pagan?","Compra directa: cuando tu entrega está verificada y aprobada. Licencia: después de que cada comprador apruebe tus datos. No hay pago por adelantado antes de completar la puerta de calidad, y las ventas de licencia no están garantizadas."],
 ["¿La valoración es el precio final?","No. Toda valoración aquí es un estimado preliminar. El precio final se confirma cuando verifiquemos tu documentación y una muestra de tus datos."],
 ["¿Qué pasa si mi muestra no coincide con lo declarado?","Entonces no hay trato. Esa verificación es la puerta de calidad, y protege a ambas partes."],
 ["¿Me quedo con mis datos?","Sí. Siempre conservas tu propia copia y puedes seguir usándola en tu negocio. Nosotros solo recibimos una copia."],
 ["¿Ya han cerrado tratos?","Todavía no — estamos lanzando ahora. Por eso cada número de esta página está marcado como estimado preliminar, y el pago solo se hace cuando se completa la puerta de calidad."]],
 conT:"Contacto",conS:"Habla con una persona de nuestro equipo.",conWa:"Escríbenos por WhatsApp",conWaMsg:"Hola, tengo una pregunta sobre DATA Patrimonio.",
 conFormT:"Envíanos un mensaje por email",fName:"Tu nombre (opcional)",fMsg:"Tu mensaje",conSend:"Enviar mensaje",conOk:"Gracias — tu mensaje quedó guardado y nuestro equipo te responderá a tu correo.",chatNote:"Más rápido: el botón de chat abajo a la derecha responde las preguntas más comunes al momento.",
 chatT:"Chatea con nosotros",chatOpen:"Chatea con nosotros",chatHello:"¡Hola! Puedo explicarte cómo funciona DATA Patrimonio: las dos formas de vender, la valoración, la puerta de calidad y la bóveda. ¿Qué te gustaría saber?",chatPh:"Escribe tu pregunta…",chatSend:"Enviar",chatWa:"Seguir por WhatsApp",chatEmail:"Enviar por email",chatEmailT:"Envía tu pregunta por email y te respondemos.",chatSent:"Enviado. Nuestro equipo te responderá a tu correo.",
 tabChats:"Chats",tabContact:"Mensajes",chatCols:["Sesión","Fecha","Idioma","Conversación"],contactCols:["Fecha","Nombre","Correo","Modalidad","Mensaje"],chatEmpty:"Sin chats todavía.",contactEmpty:"Sin mensajes por email todavía.",generalWord:"General"
});

/* price gate (Nov 25 2026, Miguel's direction): nobody sees the valuation
   until they leave name + email; the lead is saved through /api/contact
   into the same contact_messages the team panel already shows. */
Object.assign(T.en,{
 gateT:"Your valuation is ready",gateS:"To see your valuation, leave us your name and email — we'll send you the next steps there too.",
 gateName:"Your name",gateWa:"WhatsApp (optional)",gateBtn:"See my valuation →",gateNote:"No spam and no commitment. Your information stays private and secure.",
 gateErrName:"Please tell us your name.",gateLead:"Valuation lead — captured at the price gate (before the estimate was shown)"
});
Object.assign(T.es,{
 gateT:"Tu valoración está lista",gateS:"Para ver tu valoración, déjanos tu nombre y tu correo — ahí te enviamos también los siguientes pasos.",
 gateName:"Tu nombre",gateWa:"WhatsApp (opcional)",gateBtn:"Ver mi valoración →",gateNote:"Sin spam y sin compromiso. Tu información se mantiene privada y segura.",
 gateErrName:"Por favor, dinos tu nombre.",gateLead:"Lead de valoración — captado en la puerta del precio (antes de mostrar el estimado)"
});

/* appointment booking (Nov 25 2026, Miguel's direction): the step right
   after the valuation. Campaign ads point at the screening; the flow
   ends by booking the call. The Zoom link is NEVER shown here — it
   follows by email once the team confirms (no fake links). */
Object.assign(T.en,{
 bkNext:"Book your appointment →",bkContactL:"We'll contact you at:",bkDayL:"Choose a day",bkWinL:"Choose a time window",
 bkMorning:"Morning",bkMorningH:"9:00 AM – 12:00 PM ET",bkAfternoon:"Afternoon",bkAfternoonH:"1:00 – 5:00 PM ET",
 bkNoteL:"Anything we should know? (optional)",bkNotePh:"For example: the best number to reach you, or what you'd like to cover on the call…",
 bkConfirm:"Confirm my appointment",bkSkip:"Continue without an appointment",bkErrPick:"Choose a day and a time window first.",
 bkDoneT:"Your appointment is booked!",bkFor:"Your call:",
 bkDoneP:"We'll contact you to confirm your appointment. Your Zoom link will arrive by email once your appointment is confirmed.",
 bkContinue:"Continue to the agreement",
 tabBookings:"Appointments",bkCols:["Booked","Appointment","Name","Email","WhatsApp","Company profile","Estimate","Status","Zoom","Note"],bkEmpty:"No appointments yet. Bookings appear here the moment a seller reserves a slot.",
 bkZoomBtn:"Create Zoom",bkZoomFor:"Invitees: Gil, Tyler, Miguel"
});
Object.assign(T.es,{
 bkNext:"Reserva tu cita →",bkContactL:"Te contactamos en:",bkDayL:"Elige un día",bkWinL:"Elige un horario",
 bkMorning:"Mañana",bkMorningH:"9:00 AM – 12:00 PM ET",bkAfternoon:"Tarde",bkAfternoonH:"1:00 – 5:00 PM ET",
 bkNoteL:"¿Algo que debamos saber? (opcional)",bkNotePh:"Por ejemplo: el mejor número para llamarte, o qué quieres cubrir en la llamada…",
 bkConfirm:"Confirmar mi cita",bkSkip:"Continuar sin cita",bkErrPick:"Primero elige un día y un horario.",
 bkDoneT:"¡Tu cita quedó reservada!",bkFor:"Tu llamada:",
 bkDoneP:"Te contactamos para confirmar tu cita. El enlace de Zoom te llega por correo cuando tu cita esté confirmada.",
 bkContinue:"Continuar al contrato",
 tabBookings:"Citas",bkCols:["Reservada","Cita","Nombre","Correo","WhatsApp","Perfil de la empresa","Estimado","Estado","Zoom","Nota"],bkEmpty:"Sin citas todavía. Las reservas aparecen aquí en cuanto un vendedor aparta su horario.",
 bkZoomBtn:"Crear Zoom",bkZoomFor:"Invitados: Gil, Tyler, Miguel"
});
