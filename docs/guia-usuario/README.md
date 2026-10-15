# Guía de uso de ApiDental

**[Guia-ApiDental.pdf](Guia-ApiDental.pdf)**: guía paso a paso para cada rol (recepción, odontólogo, asistente, director clínico,
cajero y administradores). 14 páginas, con capturas del panel y datos demo ficticios.

El panel la ofrece como descarga: botón **Guía de uso (PDF)** en el menú lateral
(`/admin/guia/Guia-ApiDental.pdf`, copia en `apps/admin/public/guia/`).

## Regenerar

```bash
python3 docs/guia-usuario/build_pdf.py
```

Usa Brave o Chrome sin interfaz. El contenido (pasos, notas y recortes de las capturas) está en `build_pdf.py`; las capturas
en `img/`. Al cambiar el panel, actualice las capturas afectadas y vuelva a generar. El script también copia el PDF a
`apps/admin/public/guia/`; después hay que recompilar y desplegar el panel.
