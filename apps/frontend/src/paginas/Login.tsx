import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { mensajeDeError } from '../api';
import { useSesion } from '../sesion';

export function Login() {
  const { entrar } = useSesion();
  const navegar = useNavigate();
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      // Cada sesión arranca en su pantalla de inicio, no en la que dejó el usuario anterior
      navegar('/', { replace: true });
      await entrar(usuario, clave);
    } catch (err) {
      setError(mensajeDeError(err));
      setEnviando(false);
    }
  };

  return (
    <div className="login">
      <form className="tarjeta" onSubmit={enviar}>
        <img className="logo" src="/logo.png" alt="Discador" />
        <label>
          <span>Usuario</span>
          <input value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          <span>Clave</span>
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="alerta peligro">{error}</div>}
        <button className="primario grande" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
