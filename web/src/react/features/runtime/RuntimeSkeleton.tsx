import "./runtimeSkeleton.css";

/** No visible status copy: the workspace silhouette is the loading feedback. */
export function RuntimeSkeleton() {
  return (
    <main className="runtime-skeleton" aria-busy="true" aria-label="Synax">
      <div className="runtime-skeleton__titlebar" aria-hidden="true">
        <span className="runtime-skeleton__block runtime-skeleton__caption" />
      </div>
      <div className="runtime-skeleton__body" aria-hidden="true">
        <aside className="runtime-skeleton__sidebar">
          <div className="runtime-skeleton__project">
            <span className="runtime-skeleton__block runtime-skeleton__icon" />
            <span className="runtime-skeleton__block runtime-skeleton__line" />
          </div>
          <div className="runtime-skeleton__navigation">
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="runtime-skeleton__row" key={row}>
                <span className="runtime-skeleton__block runtime-skeleton__dot" />
                <span className="runtime-skeleton__block runtime-skeleton__line" />
              </div>
            ))}
          </div>
          <div className="runtime-skeleton__footer">
            <span className="runtime-skeleton__block runtime-skeleton__icon" />
            <span className="runtime-skeleton__block runtime-skeleton__caption" />
          </div>
        </aside>
        <section className="runtime-skeleton__content">
          <div className="runtime-skeleton__toolbar">
            <span className="runtime-skeleton__block runtime-skeleton__caption" />
            <span className="runtime-skeleton__block runtime-skeleton__dot" />
          </div>
          <div className="runtime-skeleton__canvas">
            <div className="runtime-skeleton__intro">
              <span className="runtime-skeleton__block runtime-skeleton__heading" />
              <span className="runtime-skeleton__block runtime-skeleton__description" />
            </div>
            <div className="runtime-skeleton__cards">
              {[0, 1, 2].map((card) => (
                <div className="runtime-skeleton__card" key={card}>
                  <span className="runtime-skeleton__block runtime-skeleton__icon" />
                  <span className="runtime-skeleton__block runtime-skeleton__line" />
                  <span className="runtime-skeleton__block runtime-skeleton__caption" />
                </div>
              ))}
            </div>
          </div>
          <div className="runtime-skeleton__composer">
            <span className="runtime-skeleton__block runtime-skeleton__description" />
            <span className="runtime-skeleton__block runtime-skeleton__icon" />
          </div>
        </section>
      </div>
    </main>
  );
}
