<template>
  <section class="w-[min(100%,58rem)] mx-auto">
    <section class="grid gap-[0.85rem] px-5 py-5 mb-[1.1rem] border border-border rounded-[1rem] shadow-[var(--shadow)]" style="background: radial-gradient(circle at top right, rgba(0,149,246,0.12), transparent 38%), linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 90%, var(--accent) 10%) 100%);">
      <h2 class="text-text">Entstehung der Webseite</h2>
      <p class="about-subtitle">Über mich</p>
      <p class="m-0 text-muted about-subtext">Seit nun mehr als 20 Jahren besuche ich die Spiele des FC Basel 1893. Mein erstes Spiel in einem Schweizer Fussballstadion durfte ich mit 15 Jahren am 22.05.2004 (FC Basel 1893 gegen die Young Boys Bern) miterleben. Durch eine Aktion meiner damaligen Schule, erhielt ich die Möglichkeit Meisterschaftspins, vor und nach dem Spiel, zu verkaufen und im Gegenzug dafür gratis das besagte Spiel zu besuchen. Der FC Basel war zu diesem Zeitpunkt bereits vorzeitig Schweizer Meister 2003/2004 und nach diesem Spiel fand die Pokalübergabe sowie die Meisterfeier statt. Dazu durften alle Meisterpin-Verkäufer einige Reihen hinter der Ersatzbank des FC Basels das Spiel verfolgen. Bei der Pokalübergabe wurde dieser direkt vor unserer Reihe von den Rängen auf das Spielfeld gebracht.</p>
      <p class="m-0 text-muted about-subtext">Nach diesem Spiel ging ich erst in der Saison 2006/2007 regelmässig an die Fussballspiele des FC Basel 1893. Mein damaliger Kollege nahm mich mit in den Sektor D (die Muttenzerkurve) und liess in mir die Faszination für den Fussball sowie die Ultrakultur aufflammen.</p>
      <p class="m-0 text-muted about-subtext">In den darauffolgenden Jahren ging ich mit meinen Kollegen an jedes Spiel des FC Basels (Heimspiele, Auswärtsspiele in der Schweiz oder auch internationale Spiele). Dabei sog ich die Energie der Schweizer Fankurven auf und lerne deren Eigenheiten kennen und schätzen.</p>
      <p class="m-0 text-muted about-subtext">Inzwischen bin ich Vater geworden und besuche zwar noch regelmässig die Heimspiele des FC Basels, die Auswärtspiele jedoch nur noch selten. Was geblieben ist, ist die Liebe zu den Choreografien und die Erinnerungen an die vielen tollen Momente die ich auf und neben den Rängen miterleben durfte.</p>
      <p class="m-0 text-muted about-subtext">- Freezy</p>
      <p class="about-subtitle">Faszination</p>
      <p class="m-0 text-muted about-subtext">Was mich dabei bis heute am meisten fasziniert sind die aufwendig gestalteten Choreografien der Fankurven. Dabei kommen verschiedene oder gar alle Elemente der Ultrakultur zusammen (Gesang, Blockfahnen, Schwenkfahnen, Banner, Spruchbänder, Leinwände, Seilzüge, Pappe, Folien, Kleidung, Fackeln, Rauchtöpfe, weitere Pyrotechnik, etc.), die Kreativität ist dabei das einzige Limit. Dabei wird je nach Choreografie von der Idee bis zur Umsetzung extrem viel Aufwand und Zeit durch die Fans investiert (diese stellen diese in ihrer Freizeit auf die Beine).</p>
      <p class="m-0 text-muted about-subtext">In meinen bisherigen 20 Jahren habe ich damit begonnen unter anderem Bilder und Videos der Choreografien der Fankurve des FC Basels (Muttenzerkurve) zu sammeln und zu sortieren. Nun habe ich endlich die Zeit gefunden diese auch Online als Webseite euch zur Verfügung zu stellen. Bitte beachtet, dass die Bilder und Videos nicht von mir erstellt wurden sondern lediglich zusammengetragen und sortiert wurden (mehr dazu im <a href="disclaimer">Disclaimer</a>).</p>
      <p class="about-subtitle">Die Choreo-Künstler vom Joggeli</p>
      <p class="m-0 text-muted about-subtext">Folgender Bericht hat mich unter anderem motiviert meine Sammlung von Choreografien der Muttenzerkurve über 20 Jahre aufrechtzuerhalten:</p>
      <div style="height: 100vh;">
        <PDFViewer
          :config="{
            src: 'joggeli.pdf',
            theme: { preference: 'light' },
            disabledCategories: ['annotation', 'form', 'annotation-shape', 'print', 'redaction', 'document', 'tools', 'panel', 'history', 'insert', 'security', 'page']
          }"
          :style="{ width: '100%', height: '100%' }"
        />
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
  import { PDFViewer } from '@embedpdf/vue-pdf-viewer';
</script>

<style scoped>
.about-view {
  height: 100%;
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
}

.about-view__message-card {
  display: grid;
  gap: 0.75rem;
  width: min(100%, 30rem);
  margin: 0 auto;
  padding: 2rem 1.5rem;
  border: 1px solid var(--border);
  border-radius: 1.4rem;
  background: var(--surface);
  box-shadow: var(--shadow);
}

.about-view__eyebrow {
  margin: 0;
  font-size: 0.73rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.about-view__title {
  margin: 0;
  font-size: 1.55rem;
  font-weight: 700;
  letter-spacing: -0.04em;
  color: var(--text);
}

.about-view__message {
  margin: 0;
  font-size: 0.96rem;
  line-height: 1.6;
  color: var(--muted);
}

.about-subtitle {
  margin: 0;
  font-size: 0.86rem;
  line-height: 1.6;

  :link { color: #347deb; }
  :visited { color: #6b34eb; }
  :hover { text-decoration: underline; }
}

.about-subtext {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.6;

  :link { color: #347deb; }
  :visited { color: #6b34eb; }
  :hover { text-decoration: underline; }
}

@media (max-width: 768px) {
  .about-view__layout {
    display: block;
    padding: 0;
  }

  .about-view__deck-shell {
    height: 100%;
    min-height: 100%;
  }

  .about-view__message-card {
    width: calc(100% - 1.5rem);
    margin: 1rem auto;
    padding: 1.55rem 1.15rem;
  }
}
</style>
