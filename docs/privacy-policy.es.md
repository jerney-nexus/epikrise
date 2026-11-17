---
title: Política de privacidad de Epikrise
permalink: /privacy-policy/es/
---

# Política de privacidad de Epikrise

Idioma: [English](https://jerney-nexus.github.io/epikrise/privacy-policy/en/) · [Deutsch](https://jerney-nexus.github.io/epikrise/privacy-policy/de/) · [Français](https://jerney-nexus.github.io/epikrise/privacy-policy/fr/) · [Italiano](https://jerney-nexus.github.io/epikrise/privacy-policy/it/) · Español

Última actualización: 2026-11-08

Responsable: Pascal Jerney, Unterdorfstrasse 7, 3322 Urtenen-Schönbühl, Suiza

Contacto para cuestiones de privacidad: admin@jerney.nexus

## 1. Ámbito de aplicación

Esta política se aplica a la aplicación de escritorio Epikrise (Windows, macOS, Linux), que usted instala localmente en su dispositivo. Tiene en cuenta la Ley federal suiza de protección de datos (revLPD) y, cuando proceda, el Reglamento General de Protección de Datos de la UE (RGPD).

## 2. Ausencia de recogida por parte del responsable

Epikrise no opera un backend propio. No existen cuentas de usuario, telemetría, herramientas de analítica ni transmisión de datos de uso al responsable. Por tanto, el responsable no recibe ningún dato personal derivado de su uso de la aplicación.

## 3. Tratamiento en su dispositivo

La aplicación trata en su dispositivo el contenido que introduce o importa (textos, documentos, imágenes, archivos PDF, tablas y contenido de páginas web). La única excepción es el envío del contenido de un caso a un endpoint remoto de IA, que solo se produce después de su confirmación (véase la sección 5). Los casos y los resultados generados se mantienen en memoria; los archivos temporales para el reconocimiento de texto se tratan en el párrafo siguiente. Cuando descarta un caso o cierra la aplicación, se borra el estado interno del caso. No están cubiertos por ello los valores de formularios, como las entradas de los campos de plantilla, ni el texto que copie usted mismo al portapapeles; estos permanecen hasta que los cambie o hasta que se sobrescriba el portapapeles. No se guarda ningún historial.

Para el reconocimiento de texto (OCR), pueden crearse archivos temporales de imagen en directorios temporales privados. Se sobrescriben antes de su eliminación. Sin embargo, el sistema operativo y el entorno de ejecución pueden conservar copias, por lo que no puede garantizarse una eliminación forense segura.

## 4. Ajustes y credenciales almacenados

- Las plantillas importadas se almacenan localmente en la aplicación.
- Las claves API se guardan en el llavero del sistema operativo (en Linux, mediante Secret Service).
- La interfaz actual no almacena de forma permanente el proveedor, el modelo, el endpoint ni los ajustes de salida y razonamiento.

## 5. Transmisión a proveedores de IA

Para generar borradores, el material preparado y su plantilla se envían al proveedor de modelos que elija. Los proveedores admitidos son OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter y endpoints compatibles con OpenAI u Ollama. Si el endpoint es local (por ejemplo, Ollama en localhost), los datos no salen de su dispositivo. Para los endpoints remotos se aplican las condiciones de privacidad de ese proveedor. Antes de que el contenido de un caso se envíe por primera vez a un endpoint remoto, la aplicación le pide que confirme el proveedor y el endpoint. Esta confirmación se aplica solo a ese caso, ese proveedor y ese endpoint; para otro caso, proveedor o endpoint, se volverá a solicitar. Sin su confirmación, no se envía ningún contenido de casos. El responsable no recibe estos datos y no es parte de su contrato con el proveedor.

Independientemente de la confirmación de cada caso, la aplicación puede ejecutar dos funciones que contactan con endpoints remotos: la obtención de la lista de modelos y la prueba de conexión. Estas envían su dirección IP y, si está configurada, su clave API almacenada al endpoint. La prueba de conexión también puede enviar una breve solicitud de prueba con el texto fijo « Reply with OK. ». En estas solicitudes no se envía contenido de casos.

## 6. Otros accesos a la red

- **Importación desde URL:** una URL que usted indique se recupera directamente y se convierte en texto legible. Los administradores pueden desactivar esta función.
- **Comprobación de actualizaciones:** si la función de actualización está activada, la aplicación descarga información de actualizaciones desde GitHub. Esto transmite su dirección IP a GitHub. La función es opcional.

## 7. Ninguna anonimización por parte de la aplicación

Epikrise no anonimiza ni seudonimiza el contenido y no detecta información identificativa. Usted es responsable de utilizar únicamente material que esté legalmente autorizado a tratar. Con arreglo a la revLPD, los datos de salud se consideran datos personales especialmente sensibles; con arreglo al RGPD, pertenecen a categorías especiales (art. 9). Por ello, utilice solo material anonimizado o sintético.

## 8. Políticas de administrador

Las organizaciones pueden restringir proveedores, endpoints, importación desde URL, funciones de plantillas y actualizaciones mediante un archivo `policy.toml`. La política es responsabilidad de la organización correspondiente.

## 9. Sus derechos

Como el responsable no recoge datos personales, las solicitudes de acceso, rectificación y supresión generalmente no pueden dirigirse al responsable. Para los datos que conserve un proveedor de modelos, póngase en contacto directamente con dicho proveedor. Para cualquier pregunta, escríbanos a admin@jerney.nexus.

## 10. Cambios

El responsable puede modificar esta política. La versión vigente está disponible en https://jerney-nexus.github.io/epikrise/privacy-policy/es/.
