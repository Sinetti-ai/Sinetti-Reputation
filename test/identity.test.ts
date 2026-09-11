import { expect } from "chai";
import { readA2AFields } from "../src/feedback";
import { agentCardUrl, readAgentCard, readRegistration } from "../src/identity";

describe("ERC-8004 registration files and A2A agent cards", function () {
  it("reads the spec's services key and the older endpoints key, and says which", function () {
    const current = readRegistration({
      name: "  Helper  ", description: "Does things", active: true,
      services: [{ name: "A2A", endpoint: "https://agent.example/.well-known/agent-card.json", version: "0.3.0" }, { name: "MCP", endpoint: "https://agent.example/mcp" }, { bogus: 1 }],
      registrations: [{ agentId: 42, agentRegistry: "eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e" }],
      supportedTrust: ["reputation", 7]
    });
    expect(current.name).to.equal("Helper");
    expect(current.services_key).to.equal("services");
    expect(current.services).to.deep.equal([
      { name: "A2A", endpoint: "https://agent.example/.well-known/agent-card.json", version: "0.3.0" },
      { name: "MCP", endpoint: "https://agent.example/mcp", version: null }
    ]);
    expect(current.registrations).to.deep.equal([{ agent_id: "42", agent_registry: "eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e" }]);
    expect(current.supported_trust).to.deep.equal(["reputation"]);

    const legacy = readRegistration({ endpoints: [{ name: "web", endpoint: "https://agent.example" }] });
    expect(legacy.services_key).to.equal("endpoints");
    expect(legacy.name).to.equal(null);
    expect(legacy.active).to.equal(null);
    expect(readRegistration({}).services_key).to.equal(null);
  });

  it("caps declared strings so a hostile file cannot fill a page", function () {
    const declared = readRegistration({ name: "x".repeat(500), description: "y".repeat(5_000), services: Array.from({ length: 200 }, () => ({ name: "web", endpoint: "https://a.example" })) });
    expect(declared.name).to.have.length(120);
    expect(declared.description).to.have.length(1_000);
    expect(declared.services).to.have.length(50);
  });

  it("finds the A2A card only behind an endpoint this service would fetch", function () {
    const https = readRegistration({ services: [{ name: "a2a", endpoint: "https://agent.example/.well-known/agent-card.json" }] });
    expect(agentCardUrl(https)).to.equal("https://agent.example/.well-known/agent-card.json");
    expect(agentCardUrl(readRegistration({ services: [{ name: "A2A", endpoint: "http://agent.example/card.json" }] }))).to.equal(null);
    expect(agentCardUrl(readRegistration({ services: [{ name: "A2A", endpoint: "https://127.0.0.1/card.json" }] }))).to.equal(null);
    expect(agentCardUrl(readRegistration({ services: [{ name: "MCP", endpoint: "https://agent.example/mcp" }] }))).to.equal(null);
  });

  it("summarises an agent card: skills, capabilities, scheme names, whether it is signed", function () {
    const card = readAgentCard({
      name: "Helper", url: "https://agent.example/a2a", version: "1.2.0", protocolVersion: "0.3.0",
      provider: { organization: "Example Org", url: "https://example.org" },
      capabilities: { streaming: true, pushNotifications: false },
      skills: [{ id: "translate", name: "Translate", description: "Text between languages", tags: ["nlp", "translation"] }, { name: "no id" }],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      signatures: [{ protected: "eyJ", signature: "abc" }]
    });
    expect(card.skills).to.deep.equal([{ id: "translate", name: "Translate", description: "Text between languages", tags: ["nlp", "translation"] }]);
    expect(card.capabilities).to.deep.equal({ streaming: true, push_notifications: false });
    expect(card.security_schemes).to.deep.equal(["bearer"]);
    expect(card.signed).to.equal(true);
    expect(card.provider).to.deep.equal({ organization: "Example Org", url: "https://example.org" });
    expect(readAgentCard({}).signed).to.equal(false);
    expect(readAgentCard({ signatures: [] }).signed).to.equal(false);
  });

  it("reads the A2A skill and task fields a rater may put in a feedback file", function () {
    expect(readA2AFields({ skills: ["translate", { id: "summarise" }, 3], taskId: " task-9 " })).to.deep.equal({ skillIds: ["translate", "summarise"], taskId: "task-9" });
    expect(readA2AFields({})).to.deep.equal({ skillIds: [], taskId: null });
  });
});
