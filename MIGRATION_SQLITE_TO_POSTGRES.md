# Migracao SQLite para PostgreSQL

## Diagnostico real do banco atual

O backend nao usa Prisma, TypeORM ou migrations relacionais. O SQLite atual possui a tabela `collections`:

- `name TEXT PRIMARY KEY`
- `payload TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Cada `payload` guarda uma colecao completa do dominio em JSON. Por isso, a migracao segura e equivalente para PostgreSQL usa:

- `name text PRIMARY KEY`
- `payload jsonb NOT NULL`
- `updated_at timestamptz NOT NULL`
- `CHECK (jsonb_typeof(payload) = 'array')`
- indice B-tree em `updated_at`
- indice GIN em `payload`

Isso preserva dados, autenticacao, permissoes, relacionamentos por ids, timestamps e formato atual sem tentar inferir foreign keys que hoje nao existem fisicamente no SQLite.

## Antes de migrar

1. Pare o backend para congelar escritas.
2. Confira se `data/liensina.sqlite` existe.
3. Configure `.env`:

```env
DATABASE_DRIVER=postgres
DATABASE_URL=defina_a_string_privada_no_env_local
DATABASE_SSL=false
DATABASE_PATH=data/liensina.sqlite
SQLITE_SOURCE_PATH=data/liensina.sqlite
```

Para Neon:

```env
DATABASE_URL=defina_a_string_privada_do_neon_no_env_local
DATABASE_SSL=true
```

## Comandos completos

Snapshot local fora do Git:

```bash
npm run db:snapshot:local
```

Migracao:

```bash
npm run db:migrate:postgres
```

Verificacao:

```bash
npm run db:verify:postgres
```

Subir com Docker:

```bash
docker compose up --build
```

## Se o PostgreSQL ja tiver dados

O script aborta por padrao para evitar sobrescrita acidental. Para substituir conscientemente:

```bash
POSTGRES_MIGRATION_OVERWRITE=true npm run db:migrate:postgres
```

No PowerShell:

```powershell
$env:POSTGRES_MIGRATION_OVERWRITE='true'
npm run db:migrate:postgres
```

## Rollback

O SQLite original deve ser preservado somente em um local seguro fora do repositorio.

```bash
npm run db:restore:local -- caminho-seguro-fora-do-git/snapshot-local
```

Depois defina:

```env
DATABASE_DRIVER=sqlite
DATABASE_PATH=data/liensina.sqlite
```

## Riscos e mitigacoes

- Escritas durante a migracao: pare o backend antes de executar os scripts.
- PostgreSQL com dados antigos: o script exige `POSTGRES_MIGRATION_OVERWRITE=true`.
- Neon exige SSL: use `DATABASE_SSL=true` ou `sslmode=require` na URL.
- Normalizacao relacional futura: faca por dominio, com migrations versionadas e testes de integridade, porque o SQLite atual nao possui foreign keys fisicas para converter automaticamente.
- Dados sensiveis: `.env`, SQLite, snapshots e credenciais estao ignorados por Git/Docker.

## Estrategia futura recomendada

1. Manter esta migracao como etapa de compatibilidade segura.
2. Evoluir as tabelas `liensina_entity_*` por dominio, adicionando colunas materiais quando necessario.
3. Substituir gradualmente leituras em memoria por repositories com filtros obrigatorios de tenant.
4. Executar validadores comparando JSON legado versus tabelas novas.
5. Remover o modo SQLite apenas depois de um ciclo completo de backup, migracao, smoke tests e rollback ensaiado.
