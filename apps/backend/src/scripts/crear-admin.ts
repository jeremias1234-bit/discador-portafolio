// Crea un administrador desde la terminal. La base arranca sin usuarios: este es el primero.
//   npm run crear-admin -- --usuario admin --nombre "Administrador"
// La clave se pide sin mostrarla; si no hay terminal, se lee una línea de la entrada estándar.
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashearClave } from '../auth/contrasenas.js';
import { esquemaClave } from '../api/autenticacion.js';
import { generarClaveSip, siguienteInterno } from '../api/usuarios.js';
import { registrarEnBitacora } from '../bitacora.js';
import { config } from '../config.js';
import { conTransaccion } from '../db/transaccion.js';

const { values } = parseArgs({
  options: { usuario: { type: 'string' }, nombre: { type: 'string' } },
});
const usuario = values.usuario?.trim().toLowerCase();
const nombre = values.nombre?.trim();
if (!usuario || !/^[a-z0-9._-]{3,32}$/.test(usuario) || !nombre) {
  console.error('Uso: npm run crear-admin -- --usuario <usuario> --nombre "<Nombre>"');
  console.error('El usuario va de 3 a 32 caracteres: letras, números, punto o guion.');
  process.exit(1);
}

function leerClave(pregunta: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      // Oculta lo que se tipea
      const escribir = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        escribir.call(rl, s.startsWith(pregunta) ? pregunta : '');
      };
    }
    rl.question(pregunta, (respuesta) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(respuesta);
    });
  });
}

const clave = await leerClave('Clave (mínimo 8 caracteres): ');
const validacion = esquemaClave.safeParse(clave);
if (!validacion.success) {
  console.error(`Clave inválida: ${validacion.error.issues[0]?.message}`);
  process.exit(1);
}
if (process.stdin.isTTY && (await leerClave('Repetir la clave: ')) !== clave) {
  console.error('Las claves no coinciden.');
  process.exit(1);
}

const db = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const creado = await conTransaccion(db, async (tx) => {
    const { rows } = await tx.query<{ id: number; interno_sip: string }>(
      `INSERT INTO usuarios (nombre, usuario, password_hash, rol, interno_sip, clave_sip)
       VALUES ($1, $2, $3, 'admin', $4, $5) RETURNING id, interno_sip`,
      [nombre, usuario, await hashearClave(clave), await siguienteInterno(tx), generarClaveSip()],
    );
    const nuevo = rows[0]!;
    await registrarEnBitacora(tx, {
      usuarioId: null, accion: 'usuario.crear', entidad: 'usuarios', entidadId: nuevo.id,
      detalle: { usuario, nombre, rol: 'admin', origen: 'crear-admin (terminal)' },
    });
    return nuevo;
  });
  console.log(`Admin "${usuario}" creado (id ${creado.id}, interno ${creado.interno_sip}).`);
} catch (err) {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
    console.error(`El usuario "${usuario}" ya existe.`);
    process.exit(1);
  }
  throw err;
} finally {
  await db.end();
}
