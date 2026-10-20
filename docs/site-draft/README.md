# Arrival documentation — черновик структуры

Это редакционный план будущего сайта документации. Страницы содержат тезисы и задания на примеры; они ещё не являются готовым справочником или спецификацией. Заголовки и пути рассчитаны на англоязычный сайт, рабочие заметки написаны по-русски.

Основные читатели: разработчик интеграции, агент — автор программ, контрибьютор интерпретатора. Главный маршрут: понять ценность → запустить → подключить инструменты → получить понятную обратную связь → исследовать происхождение результата → извлечь вычисление через uneval.

## Навигация

- [Главная](outlines/index.md)
- Start here
  - [What is Arrival?](outlines/start/overview.md)
  - [Quickstart](outlines/start/quickstart.md)
  - [Your first agent integration](outlines/start/agent-integration.md)
- Write Arrival
  - [Language tour](outlines/language/tour.md)
  - [Working with data](outlines/language/data.md)
  - [Tolerance and compatibility](outlines/language/tolerance.md)
  - [Understanding errors](outlines/language/errors.md)
  - [Modules and Sugarcoat](outlines/language/modules-and-sugarcoat.md)
- Embed Arrival
  - [Execution and sessions](outlines/embedding/execution.md)
  - [Connecting an existing tool runtime](outlines/embedding/tool-runtime.md)
  - [Case study: Harness — редакционные заметки](embedding/harness-case-study.md)
  - [JavaScript interop](outlines/embedding/interop.md)
  - [Validation, cancellation, and budgets](outlines/embedding/control.md)
  - [Replay and deferred effects](outlines/embedding/replay-and-effects.md)
- Build capabilities
  - [Your first capability](outlines/capabilities/overview.md)
  - [Configuration and optional features](outlines/capabilities/configuration.md)
  - [Resources and disposal](outlines/capabilities/resources.md)
  - [Dependencies, symbols, and preludes](outlines/capabilities/composition.md)
  - [Provenance and cache contracts](outlines/capabilities/contracts.md)
  - [Testing a capability](outlines/capabilities/testing.md)
- Explain results
  - [Provenance](outlines/results/provenance.md)
  - [Uneval](outlines/results/uneval.md)
  - [Grounding, attestation, and guarantees](outlines/results/guarantees.md)
- Recipes
  - [Integration recipes](outlines/recipes/index.md)
- Reference
  - [Reference map](outlines/reference/index.md)
- For agents
  - [Agent documentation](outlines/agents/index.md)
- Internals
  - [Contributor reading paths](outlines/internals/index.md)

## Первая публикация

Сначала довести до исполняемых примеров: overview, quickstart, agent integration, tolerance/errors, capability overview/configuration/resources, provenance и uneval. Добавить компактный справочник по используемым API. Остальные страницы публиковать по мере наполнения; пустые планы не должны попадать в пользовательский sidebar.

## Редакционные правила

- Объяснять tolerance, диагностику, provenance и uneval через наблюдаемый результат.
- Отделять семантику Arrival от решений хоста. В частности, продолжение после ошибки, фоновые задания, разрешения и watcher принадлежат интеграции.
- Ручной текст: учебные маршруты, объяснения, рецепты и выбор подхода. Из кода по возможности получать сигнатуры, символы, диагностики и таблицы совместимости.
- Проверять исполняемые примеры. Вывод ошибки брать из реального запуска, а не придумывать.
- Существующие документы подсистем — источники для проверки и раздела Internals. Не копировать их целиком в пользовательский маршрут.
- Каждая опубликованная страница должна иметь стабильный адрес и доступное текстовое представление. Короткая agent card остаётся отдельным артефактом.
- В Starlight задавать учебный порядок явно; автогенерацию использовать для справочных групп. Опубликованный сайт — `../site`: он монтирует живые документы из репозитория и не публикует этот каталог. Планы страниц лежат в `outlines/`.

## Найденные расхождения, которые нужно учесть

- `packages/arrival/docs/environments.md` ещё упоминает режимы `degradation: "forbid" | "doors"`; текущие `common/degradation.ts` и тесты описывают автоматический `requiresConfig` без такого переключателя.
- Публичный путь `EnvCapability.define` принимает `resources(config) => bag`; у bag обрабатывается `Symbol.asyncDispose`. Не смешивать это с отдельной моделью `ResourceCell`/`Ref` и не обещать автоматическую обработку `Symbol.dispose` без проверки реализации.
- В harness обычный REPL создаёт новый scope на вызов и не включает `EvalTrace`; watcher включает trace на итерацию. Его пример нельзя выдавать за готовую интеграцию uneval.
- Состояние 0.x и границы гарантий описывать спокойно и конкретно. Прослеживаемость источника не доказывает истинность его данных.
