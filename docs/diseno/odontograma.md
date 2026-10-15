# Odontograma: especificación visual para el panel (sin implementar el frontend)

> **Formato clínico por validar.** No se declara cumplimiento de normas del MINSA hasta su validación formal. El panel debe mostrar siempre este aviso junto al odontograma. Reglas y API: [`../arquitectura/incremento-3-5-odontograma.md`](../arquitectura/incremento-3-5-odontograma.md). Ejemplo (ficticio): [`odontograma-demo.svg`](odontograma-demo.svg) y [`odontograma-demo.pdf`](odontograma-demo.pdf).

## 1. Principio
Un dibujo **simple y reconocible**: dos hileras de piezas, cada pieza un cuadrado dividido en cinco superficies. Se toca una superficie, se elige un estado y listo. **Nada sugiere tratamientos**: el odontograma registra lo que el profesional declara.

## 2. De dónde sale todo (no duplicar reglas)
`GET /v1/clinical/odontogram/spec` entrega: `layout` (orden de las piezas), `teeth`, `cell.polygons` (geometría de la pieza), `surfaceRules`, `toothStatuses`, `surfaceStates` (con `color` y `pattern`), `marks`, `limits`, `formatNotice` y un `example`. El panel **no define** su propio catálogo.

## 3. Geometría de una pieza (celda de 36 × 36)
```
 ┌───────────────┐     top    = (0,0)(36,0)(24,12)(12,12)
 │ ╲    top    ╱ │     bottom = (0,36)(36,36)(24,24)(12,24)
 │  ┌─────────┐  │     left   = (0,0)(12,12)(12,24)(0,36)
 │l │ center  │ r│     right  = (36,0)(24,12)(24,24)(36,36)
 │  └─────────┘  │     center = (12,12)(24,12)(24,24)(12,24)
 │ ╱  bottom   ╲ │
 └───────────────┘
```
**Qué superficie va en cada lado** (la API ya lo calcula; ver `surfaceSide` en el servidor):
- **O** (oclusal / incisal): centro.
- **V** (vestibular): arcada superior → arriba; arcada inferior → abajo (hacia afuera).
- **L** (lingual / palatina): arcada superior → abajo; arcada inferior → arriba.
- **M** (mesial): hacia la **línea media**. **D** (distal): hacia el fondo.
  - Cuadrantes 1, 4, 5 y 8 (derecha del paciente, a la **izquierda** del dibujo): M = derecha del cuadrado, D = izquierda.
  - Cuadrantes 2, 3, 6 y 7: M = izquierda, D = derecha.

## 4. Distribución
Paso 40 px por pieza (36 + 4), con un **espacio de 18 px en la línea media** y una línea punteada. Número FDI **arriba** de la hilera superior y **debajo** de la inferior (11 px).
- **Permanente:** hilera superior `18 17 16 15 14 13 12 11 | 21 … 28`, inferior `48 … 41 | 31 … 38`.
- **Temporal:** `55 … 51 | 61 … 65` y `85 … 81 | 71 … 75`.
- **Mixta:** cuatro hileras (permanente superior, temporal superior, temporal inferior, permanente inferior).
El SVG de la API (`GET …/export?format=svg`) ya implementa esta distribución: el panel puede **incrustarlo** o reproducirla.

## 5. Estados y marcas (siempre color **y** patrón)
| Elemento | Representación |
|---|---|
| Caries | rayas diagonales rojas |
| Restauración | relleno azul sólido |
| Sellante | puntos verdes |
| Fractura | cuadrícula cruzada naranja |
| Otro hallazgo | cuadrícula gris |
| Pieza **ausente** | aspa negra sobre la celda |
| **Sin erupcionar** | borde punteado |
| **Implante** / **Resto radicular** | círculo con **I** / **R** |
| **Corona** | círculo alrededor |
| **Endodoncia** | línea vertical |
| **Prótesis** | barra sobre (arcada superior) o bajo (inferior) la pieza |
El significado **nunca depende solo del color** (impresión en blanco y negro, daltonismo). Colores y patrones vienen del `spec`.

## 6. Interacción (mínimo de pasos)
1. **Elegir la pieza** (clic/toque o teclado: flechas entre piezas, Enter).
2. Aparece **un solo panel lateral** (no un modal) con: estado de la pieza (Presente · Ausente · Sin erupcionar · Implante · Resto radicular), las **5 superficies** como botones y la lista de **marcas**.
3. Tocar una superficie → elegir el hallazgo (o "Quitar"). Una nota corta, opcional.
4. **Se guarda solo** el borrador al dejar de tocar unos segundos (`PUT …/draft` con `expectedEtag`; mostrar "Guardado"). **"Guardar versión"** (`POST …/close`) es el único paso final; **corregir** pide motivo y contraseña **en el mismo cuadro**.
5. Barra superior: **Dentición** (Permanente · Temporal · Mixta), estado (**Borrador · Guardada · Corregida**), versión y **Exportar PDF**.
Evitar: asistentes de varios pasos, confirmaciones repetidas y textos técnicos (`CARIES`, `ENTERED_IN_ERROR`…): mostrar las etiquetas del `spec` y de las respuestas (`stateLabel`, `kindLabel`).

## 7. Mensajes
| Situación | Texto |
|---|---|
| Aviso permanente | "Formato clínico por validar." (`formatNotice`) |
| Borrador ajeno | "Hay un borrador en curso de otro odontólogo." (`contentHidden`) |
| Conflicto de versión | "Alguien modificó esto mientras trabajaba. Vuelva a cargarlo." |
| Guardar corrección | "Indique el motivo y confirme con su contraseña. Esto no es una firma digital, legal ni clínica." |
| Sin permiso (asistente) | "Su perfil no ve el odontograma." (sin ocultar que el paciente existe) |
| Exportación | "Se descargará un PDF con los datos del paciente. Guárdelo con cuidado." |

## 8. Accesibilidad
Cada pieza es un control con nombre accesible ("Pieza 16: presente, oclusal caries"); orden de tabulación = orden de lectura; foco visible; contraste AA; mismo contenido disponible como **lista de hallazgos por pieza** (el PDF la incluye); no usar rojo como único indicador.

## 9. Datos demo para mostrarlo
`npm run db:seed` (solo desarrollo): **Lucía Demo Adulta** (guardado y rectificado, versión 4), **Mateo Demo Menor** (dentición mixta, borrador) y **Jorge Demo Repetido** (guardado). Cuentas en [`ficha-de-atencion.md`](ficha-de-atencion.md), sección 9. Todo ficticio.
