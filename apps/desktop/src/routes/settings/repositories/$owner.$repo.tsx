import { createFileRoute } from "@tanstack/react-router";
import { RepositoryDetailPage } from "#/features/settings/repositories/repository-detail-page";

export const Route = createFileRoute("/settings/repositories/$owner/$repo")({
	component: RepositoryDetail,
});

function RepositoryDetail(): React.ReactElement {
	const params = Route.useParams();
	return <RepositoryDetailPage owner={params.owner} repo={params.repo} />;
}
