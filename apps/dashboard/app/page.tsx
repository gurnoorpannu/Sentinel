const foundations = [
  'PostgreSQL-backed durability',
  'Lease and generation fencing',
  'Idempotent side effects',
  'Saga compensation',
];

export default function Home() {
  return (
    <main>
      <nav>
        <span className="mark">S</span>
        <span>Sentinel</span>
        <span className="phase">Foundation · Phase 1</span>
      </nav>

      <section className="hero">
        <p className="eyebrow">Durable workflow orchestration</p>
        <h1>Workflows that recover when everything else fails.</h1>
        <p className="lede">
          Sentinel coordinates multi-step operations with PostgreSQL as the source of truth,
          protecting every transition from crashes, retries, and stale workers.
        </p>

        <div className="foundations">
          {foundations.map((foundation, index) => (
            <article key={foundation}>
              <span>0{index + 1}</span>
              <p>{foundation}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
