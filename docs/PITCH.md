# 🎤 Pitch: FrictionSwarm (4:00)

Guion para las 7 escenas del pitch mode del dashboard (`/pitch?run=fixture-proven`). Avanzás con `→` o `Espacio` y abrís las notas con `N`. Los números son los que muestra ese run. Los títulos de los slides son los de la versión en español del deck (#66).

| # | Slide | Tiempo |
|---|---|---|
| 1 | Problema: *Los POs shipean a ciegas.* | 0:00–0:40 |
| 2 | Seis meses de PostHog: *¿Qué release empeoró el funnel de ventas?* | 0:40–1:30 |
| 3 | El fix: *Un coding agent abre el PR* | 1:30–2:00 |
| 4 | Re-test del swarm: *30 agents con restricciones prueban el fix* | 2:00–2:40 |
| 5 | Antes / después: *Personas reales antes, usuarios sintéticos después* | 2:40–3:10 |
| 6 | Por qué confiar: *Las restricciones se aplican, no se piden en el prompt* | 3:10–3:40 |
| 7 | Visión: *CI para UX.* | 3:40–4:00 |

> Los tiempos que muestra el deck (`scenes.ts`) suman 3:00. Este guion usa 4:00, así que no te guíes por el reloj de las notas.


## Reparto entre presentadores

Cada persona se queda con slides consecutivos para que haya pocos cambios de voz. Cada pase de palabra cierra con una frase puente: quien termina anticipa lo que viene y la siguiente persona arranca desde ahí.

### Dos personas

| Quién | Slides | Tiempo | Tema |
|---|---|---|---|
| **A** | 1 · Problema, 2 · Seis meses de PostHog, 3 · El fix | 0:00–2:00 (2:00) | Qué está roto y cómo se arregla |
| **B** | 4 · Re-test del swarm, 5 · Antes / después, 6 · Por qué confiar, 7 · Visión | 2:00–4:00 (2:00) | Cómo sabemos que el arreglo funciona |

- **Pase A → B (fin del slide 3):** A cierra con *"…así que no puede mejorar las métricas haciendo trampa. Pero un PR no alcanza: hay que saber si funciona."* B arranca el slide 4 con *"En vez de esperar semanas de tráfico…"*.
- **Por qué este corte:** las dos mitades duran lo mismo y cada una cuenta una historia completa: A, el problema; B, la verificación. B cierra con Rosa, retomando el gancho de A.

### Tres personas

| Quién | Slides | Tiempo | Tema |
|---|---|---|---|
| **A** | 1 · Problema, 2 · Seis meses de PostHog | 0:00–1:30 (1:30) | El problema y el diagnóstico |
| **B** | 3 · El fix, 4 · Re-test del swarm | 1:30–2:40 (1:10) | El arreglo y los agents |
| **C** | 5 · Antes / después, 6 · Por qué confiar, 7 · Visión | 2:40–4:00 (1:20) | El veredicto y por qué creerle |

- **Pase A → B (fin del slide 2):** A cierra con *"…y dice desde qué release pasa. Con eso, ya sabemos qué arreglar."* B arranca el slide 3 con *"Los dos hallazgos más graves van a un agente de código…"*.
- **Pase B → C (fin del slide 4):** B cierra con *"…y el enjambre la encuentra igual. ¿Y cómo les fue?"* C arranca el slide 5 con *"Antes: los usuarios del historial…"*.
- **Por qué este corte:** A abre con Rosa y C cierra con ella, así la historia empieza y termina en el mismo personaje. B queda con la parte técnica (Claude Code, preview, personas con restricciones), que conviene que la cuente quien mejor la conozca. A tiene el bloque más largo, pero es el más narrativo.

### Para cualquier reparto

- **Una sola persona maneja el teclado** (`→` para avanzar) durante todo el pitch, o cada presentador avanza sus propios slides. Decidanlo antes y ensáyenlo.
- **Quien no está hablando no se mueve ni mira el celular:** mira la pantalla o a quien está hablando.
- **Las preguntas del jurado** las responde quien presentó ese tema. Por ejemplo: las de "¿los datos son reales?" van a A, y las de "¿por qué confiar en los agents?" van a C (o a B si son técnicas).

---

## 1 · Problema (0:00–0:40)

*[Aparece el título; después la línea de tiempo se dibuja de izquierda a derecha]*

> "Les presento a Rosa. Tiene 67 años, ve poco y quiere comprarle una remera a su nieto. Llega al checkout y no encuentra el botón para seguir, porque es un link gris claro de 11 píxeles. Hace clic tres veces en el lugar equivocado y se va.
>
> A Rosa no la ve nadie, porque **los POs shipean a ciegas**: la fricción aparece como drop-off, semanas después. *[señalar la línea de tiempo]* El 9 de septiembre sale el release *Accounts* y en la revisión se ve bien. Durante cinco semanas los clientes se van sin hacer ruido. Cuando alguien mira el dashboard, el checkout mobile cayó del **9,6% al 3,5%**.
>
> Para entonces ya se perdieron las ventas, y un A/B test necesita semanas más de tráfico para decir algo."

## 2 · Seis meses de PostHog (0:40–1:30)

*[Se dibuja el gráfico; esperar a que aparezcan los círculos y la lista "Se rompió con"]*

> "FrictionSwarm es **CI para la experiencia de usuario**: encuentra la fricción en la analítica que ya tenés, la arregla y verifica el arreglo antes de que lo vea un cliente.
>
> Nuestra tienda de demo no tiene clientes, así que **generamos seis meses de historial de PostHog simulado**, unas 27 mil sesiones con los mismos eventos que manda el tracking real de la tienda. Escondimos 5 fricciones, cada una introducida por un release distinto. FrictionSwarm no sabe cuáles son: lee los eventos, separa a los usuarios por segmento y tiene que encontrarlas solo.
>
> *[señalar los círculos]* Cada círculo marca el release que rompió un segmento. *[señalar la lista de la derecha]* Baja visión cayó del 14% al 5,5% con el *Checkout redesign*. Mobile y desktop cayeron con *Accounts*.
>
> Y no reporta solo 'la conversión bajó'. Arma findings que dicen qué pasó: por ejemplo, que los usuarios mobile abandonan en un paso de registro que el flujo no requiere, con 229 envíos fallidos. Y dice desde qué release pasa."

## 3 · El fix (1:30–2:00)

*[Aparece el pipeline; después las tarjetas F2 y F5 en "Findings que ataca"]*

> "Los dos hallazgos más graves van a un agente de código, Claude Code: el registro obligatorio que frena a mobile, y el botón 'Continue to payment' que la gente con baja visión no encuentra. El agente modifica el repo de la tienda, abre un PR en draft y Netlify genera un preview.
>
> *[señalar el badge "Rehearsal · sin PR abierto"]* Como ven, esto es un ensayo: en el escenario no abrimos un PR real, pero el resto del pipeline es el mismo. El agente no puede tocar el tracking ni sacar pasos obligatorios como el pago, así que no puede mejorar las métricas haciendo trampa."

## 4 · Re-test del swarm (2:00–2:40)

*[El replay corre unos 24 s: los agentes cruzan el funnel de izquierda a derecha]*

> "En vez de esperar semanas de tráfico, el preview lo prueba un enjambre. Así se ve el re-test: **30 agentes de IA**, diez Rosas, diez Kais y diez compradores típicos, con semillas nuevas.
>
> Kai tiene 19 años, compra desde el celular y tiene poca paciencia. Los agentes compran con el mismo tracking de PostHog que los usuarios, así que los analizamos con el mismo código.
>
> *[señalar "Salieron de la tienda"]* Cuando un agente abandona, deja el motivo: 'Me borró toda la dirección al aplicar el cupón, no la vuelvo a escribir'. Esa es una fricción que todavía no arreglamos, y el enjambre la encuentra igual."

## 5 · Antes / después (2:40–3:10)

*[Las barras se llenan; al final aparece el sello]*

> "Antes: los usuarios del historial en producción. Después: el enjambre en el preview.
>
> Baja visión pasa del **5,6%** al **40%** con Rosa: **+34 puntos**. Mobile pasa del **3%** al **30%** con Kai: **+27**. El comprador de desktop es el grupo de control, y lo único que nos importa de él es que **no empeore**.
>
> Son poblaciones distintas, así que es un chequeo direccional antes del merge, no un A/B test. Como supera el umbral, el flujo queda **aprobado por los agentes** y el PR pasa a revisión. Si no lo superara, el PR se cierra con la etiqueta `not-proven`."

## 6 · Por qué confiar (3:10–3:40)

*[Primero la vista de Rosa, después la grilla de Kai, después el 5/5]*

> "¿Por qué confiar en agentes? Porque **las restricciones se aplican, no se piden en el prompt**. *[Rosa]* Esto es lo que ve el agente de Rosa: la pantalla reducida y borrosa. El texto chico o de bajo contraste directamente no existe para ella. *[Kai]* Para Kai, cada cuadrado es un toque: si el botón es más chico, el toque se pierde.
>
> El grupo de control no puede empeorar, cada re-test usa semillas nuevas y un atajo a la confirmación no cuenta como compra.
>
> *[señalar 5/5]* Y como las fricciones las plantamos nosotros, podemos comprobar que acierta: **encontró las 5 y cada una con el release que la causó**."

## 7 · Visión (3:40–4:00)

*[Los checks del PR se van poniendo en verde]*

> "Hoy hacemos esto con una tienda, un flujo y tres segmentos. La visión: **CI para UX**. Que cada actualización del ecommerce tenga estos checks, igual que hoy tiene tests.
>
> **FrictionSwarm convierte la analítica que ya tenés en arreglos verificados.** Para que la próxima vez Rosa pueda terminar su compra. Gracias."

---

## Notas para presentar

- **El deck dice "reales" en varios lugares:** "solo usuarios reales" (slide 2), "Usuarios reales" en las barras (slide 5), "evidencia de personas reales" (slide 7). La nota del slide 2 en `scenes.ts` dice "Estos son los datos reales de PostHog de la tienda". Para el sistema son usuarios reales porque excluye el tráfico del enjambre, pero el jurado lo va a leer como "datos reales". El guion aclara que el historial es simulado; conviene ajustar también esos textos.
- **El slide 5 muestra +87 pts para el control.** No lo leas como mejora: son 10 agentes contra sesiones simuladas. Decí solo "no empeoró" (el slide 6 lo muestra como "La persona de control se mantiene").
- **Hay dos cantidades de sesiones distintas.** 27 mil es el historial completo de seis meses; 4,8K son las sesiones de la ventana analizada (los últimos 28 días), que es lo que muestran los slides 2 y 7. Si te preguntan, explicá la diferencia.
- **Dejá el run cargado antes de subir.** Abrí `/pitch?run=fixture-proven` y apretá `F` para pantalla completa. No dependas de un run en vivo.
- **Qué es real y qué es simulado.** Real: el análisis, las restricciones de las personas y el veredicto. Simulado: el historial de usuarios y, en este run, el re-test del enjambre. El fix es un ensayo (el slide 3 lo muestra con el badge). Tenelo claro por si pregunta el jurado.
- **Las citas de los agentes en el slide 4 están en inglés.** El guion las dice traducidas.
- **Si te pasás de tiempo,** recortá el slide 6 a una frase: "restricciones impuestas, grupo de control, semillas nuevas, 5 de 5".
