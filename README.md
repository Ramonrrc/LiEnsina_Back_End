# LiEnsina Back End

API NestJS do LiEnsina com persistencia em PostgreSQL/SQLite e autenticacao JWT.

## Autenticacao

- Access token JWT com expiracao curta: `JWT_ACCESS_EXPIRES_IN=30m`.
- Refresh token opaco, salvo no banco apenas como hash SHA-256.
- Refresh token enviado em cookie `HttpOnly`, com `SameSite=Lax`.
- Rotacao de refresh token a cada renovacao de sessao.
- Logout revoga a sessao de refresh ativa.
- Senhas de usuarios sao persistidas com hash `bcrypt`.

## Ambiente

Crie um `.env` a partir de `.env.example` e troque obrigatoriamente o `JWT_SECRET` por um segredo longo e exclusivo do ambiente.

```bash
npm install
npm run start:dev
```

A API sobe em `http://localhost:3001/api`.

## Banco

O runtime atual usa a tabela `collections`. No SQLite antigo, `payload` era `TEXT` com JSON; no PostgreSQL, `payload` passa a ser `jsonb`, com `name` como chave primaria e validacao para garantir arrays JSON.

Variaveis principais:

- `DATABASE_DRIVER=postgres` para PostgreSQL, `sqlite` para rollback local.
- `DATABASE_URL=postgresql://usuario:senha@host:5432/banco`.
- `DATABASE_SSL=true` ou `require` para Neon.
- `DATABASE_PATH=data/liensina.sqlite` para o SQLite legado.

## Migracao SQLite -> PostgreSQL

1. Garanta que o backend esteja parado para congelar escritas no SQLite.
2. Configure `.env` com `DATABASE_URL`.
3. Rode backup:

```bash
npm run db:backup:sqlite
```

4. Migre os dados:

```bash
npm run db:migrate:postgres
```

Se o PostgreSQL ja tiver linhas em `collections`, o script aborta. Para substituir conscientemente:

```bash
POSTGRES_MIGRATION_OVERWRITE=true npm run db:migrate:postgres
```

5. Verifique contagens por colecao:

```bash
npm run db:verify:postgres
```

6. Suba a API com `DATABASE_DRIVER=postgres`.

Rollback para SQLite:

```bash
npm run db:rollback:sqlite -- data/backups/liensina.sqlite.backup-AAAA-MM-DDTHH-mm-ss-sssZ
```

Depois defina `DATABASE_DRIVER=sqlite` e mantenha `DATABASE_PATH` apontando para o arquivo restaurado.
