# opencode-rundev

**El «Run & Debug» de VS Code, para el mundo terminal-first.**

`rundev` levanta y baja el entorno de desarrollo de un repo desde OpenCode: contenedores, servidores
de desarrollo, el emulador o simulador y el navegador con perfil propio del proyecto. Sin LLM en el
medio, sin `Ctrl+F5`, sin dejar procesos huérfanos.

```sh
/rundev up            # levanta lo que falte (idempotente, no bloqueante)
/rundev status        # qué está arriba, de quién es y qué quedó huérfano
/rundev down          # baja lo que rundev levantó, verifica y reporta
/rundev init          # analiza el repo y propone el manifiesto (una vez por repo)
/rundev logs api      # sigue los logs de un servicio
/rundev doctor        # valida el manifiesto y el entorno
```

## Por qué

Trabajar con un agente en la terminal es cómodo hasta que hay que **levantar el proyecto**:

- el agente improvisa: lee prosa, adivina comandos, espera de más y deja cosas colgadas;
- lo que el agente levantó no siempre se puede bajar después;
- abrir la app termina usando **tu** navegador, con tu sesión y tu historial.

`rundev` mueve eso a un manifiesto declarativo por repo y a un motor determinista. El agente decide
*qué* necesita; el comando sabe *cómo* se levanta y cómo se baja.

## Instalación

```jsonc
// opencode.json(c)
{
  "plugins": ["opencode-rundev"]
}
```

## El manifiesto: `.opencode/rundev.json`

Cada servicio declara **cómo se comprueba** y **cómo se baja**. Lo que no sabe verificarse ni morir
no entra al manifiesto.

```jsonc
{
  "version": 1,
  "default": ["db", "api"],
  "services": {
    "db": { "kind": "compose", "file": "docker-compose.yml", "service": "mysql", "port": 3306 },
    "api": {
      "kind": "process",
      "up": "yarn dev",
      "port": 4000,
      "health": "http://localhost:4000/health"
    },
    "web": { "kind": "process", "up": "yarn dev -- --port 5173 --strictPort", "port": 5173 },
    "browser": { "kind": "browser", "url": "http://localhost:5173", "profile": ".opencode/.chrome-profile" },
    "app": {
      "kind": "interactive",
      "defaultTarget": "android",
      "targets": {
        "android": { "device": "emulator-5554", "envSection": "ANDROID" },
        "ios": { "device": "iPhone 16", "envSection": "IOS" }
      }
    }
  }
}
```

### Kinds

| kind | Qué es | Cómo se comprueba | Cómo se baja |
|---|---|---|---|
| `compose` | Un servicio de `docker compose` | `docker compose ps` | `docker compose stop` (nunca `-v`) |
| `process` | Un servidor en el host (`yarn dev`, `deno task dev`) | pidfile + `check`/`health` | SIGTERM al grupo, con verificación |
| `browser` | Chrome con perfil del proyecto | `pgrep` por perfil | cierra solo ese perfil |
| `interactive` | Algo que abre un panel (`flutter run`) | no verificable (no hay IPC) | el panel es tuyo |

### Overrides de máquina

`.opencode/rundev.local.json` (gitignored) pisa lo que es específico de esta máquina:

```jsonc
{ "services": { "app": { "targets": { "android": { "device": "pixel_8_api_36" } } } } }
```

## Reglas de la casa

- **`up` es idempotente y no bloqueante**: arranca y sale; lo que ya está arriba no se toca.
- **`down` solo baja lo que levantó rundev.** Un proceso tuyo ocupando el puerto se reporta, no se mata.
- **Nunca borra volúmenes ni datos.**
- **El `.env` solo se verifica**: si la sección activa no coincide con el target pedido, `up` se detiene
  y te lo dice. Cambiarla es explícito (`/rundev env IOS`).
- **El panel de terminal hereda el cwd del panel enfocado**, así que todo comando arranca con
  `cd '<raíz-del-repo>' &&` — validado antes de tipear.

## Herramientas para el agente

El mismo motor se expone como herramientas, para que el agente levante lo que necesita sin gastar
turnos adivinando: `rundev_status`, `rundev_up`, `rundev_down`, `rundev_logs`.

## Smoke test

```sh
deno run -A src/smoke.ts
```

## Estado

v0.1 — en desarrollo. Probado en macOS con Ghostty.
