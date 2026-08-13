const { createClient } = require('@supabase/supabase-js');

// Cliente separado SIN schema fijo — Storage vive fuera del esquema de tablas
// (landscape), es un concepto de proyecto completo en Supabase.
const storageClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BUCKET = 'landscape-storage';

/**
 * Sube un buffer a Storage siguiendo la convención de paths de la spec:
 * projects/{project_id}/{subfolder}/{filename}
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {'original'|'references'|'generations'|'final'} params.subfolder
 * @param {Buffer} params.buffer
 * @param {string} params.originalFilename
 * @param {string} params.mimeType
 * @returns {Promise<string>} URL firmada de larga duración (el bucket es privado)
 */
async function uploadProjectFile({ projectId, subfolder, buffer, originalFilename, mimeType }) {
  const ext = (originalFilename.split('.').pop() || 'jpg').toLowerCase();
  const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg';
  const path = `projects/${projectId}/${subfolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;

  const { error: uploadError } = await storageClient.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });

  if (uploadError) throw new Error(`Error subiendo a Storage: ${uploadError.message}`);

  // Bucket privado → generamos signed URL de larga duración (1 año).
  // El frontend debería renovarla periódicamente o el backend regenerarla al servir el proyecto.
  const { data: signed, error: signError } = await storageClient.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 365);

  if (signError) throw new Error(`Error firmando URL: ${signError.message}`);

  return { path, url: signed.signedUrl };
}

/** Descarga un archivo desde una URL externa (ej. output temporal de Replicate) y lo persiste. */
async function downloadAndStoreImage({ sourceUrl, projectId, subfolder }) {
  const fetch = require('node-fetch');
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`No se pudo descargar la imagen desde ${sourceUrl} (${res.status})`);

  const buffer = await res.buffer();
  const contentType = res.headers.get('content-type') || 'image/png';

  return uploadProjectFile({
    projectId,
    subfolder,
    buffer,
    originalFilename: `output.${contentType.split('/')[1] || 'png'}`,
    mimeType: contentType,
  });
}

module.exports = { uploadProjectFile, downloadAndStoreImage, BUCKET };
