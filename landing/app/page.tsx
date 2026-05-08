import { Hero } from "../components/hero";
import { Features } from "../components/features";
import { InstallSection } from "../components/install-section";
import { Architecture } from "../components/architecture";
import { Footer } from "../components/footer";

export default function Page() {
  return (
    <>
      <Hero />
      <main className="mx-auto max-w-5xl px-6">
        <Features />
        <InstallSection />
        <Architecture />
      </main>
      <Footer />
    </>
  );
}
