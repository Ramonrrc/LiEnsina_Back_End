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

Crie um `.env` a partir de `.env.example` e troque obrigatoriamente `JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET` por segredos longos, diferentes entre si e exclusivos do ambiente.

```bash
npm install
npm run start:dev
```

A API sobe em `http://localhost:3001/api`.

## Banco

Em PostgreSQL, o runtime persiste cada colecao em tabelas relacionais por entidade, como `liensina_entity_students`, `liensina_entity_evaluations` e `liensina_entity_schools`. Essas tabelas possuem `id` como chave primaria, `school_id` indexado quando aplicavel e FK para escolas, mantendo o payload JSONB por registro para compatibilidade durante a migracao.

No SQLite local legado, a API ainda usa a tabela `collections` como armazenamento de desenvolvimento/rollback.

Variaveis principais:

- `DATABASE_DRIVER=postgres` para PostgreSQL, `sqlite` para rollback local.
- `DATABASE_URL` com a string de conexao privada do PostgreSQL, definida apenas na `.env` local/servidor.
- `DATABASE_SSL=true` ou `require` para Neon.
- `DATABASE_PATH=data/liensina.sqlite` para o SQLite legado.

## Dump PostgreSQL

Com o Postgres do Docker em execucao, gere um dump local em formato custom do `pg_dump`:

```bash
npm run db:dump:postgres
```

Por padrao o arquivo fica fora do repositorio, em `../Backups_LiEnsina/postgres/` a partir da pasta raiz do projeto, junto de um manifesto `.json`. Para escolher outro destino, defina `POSTGRES_DUMP_DIR`.

Para restaurar conscientemente um dump no Postgres local:

```bash
npm run db:restore:postgres -- ../Backups_LiEnsina/postgres/liensina-postgres-ARQUIVO.dump
```

Se houver mais de um container Postgres rodando, defina `POSTGRES_CONTAINER=nome-do-container` antes do comando.

## Migracao SQLite -> PostgreSQL

1. Garanta que o backend esteja parado para congelar escritas no SQLite.
2. Configure `.env` com `DATABASE_URL`.
3. Gere snapshot local fora do Git, em storage seguro e criptografado:

```bash
npm run db:snapshot:local
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

Rollback para SQLite usando um snapshot armazenado fora do repositorio:

```bash
npm run db:restore:local -- caminho-seguro-fora-do-git/snapshot-local
```

Depois defina `DATABASE_DRIVER=sqlite` e mantenha `DATABASE_PATH` apontando para o arquivo restaurado.
